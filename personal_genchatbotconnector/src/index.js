// This code is rewritten to use the standard 'fetch' API instead of the incompatible @google-cloud/dialogflow library.
// It directly interacts with the Dialogflow REST API to avoid Node.js-specific dependencies.

// Helper function to create a signed JWT for authentication
async function createJWT(payload, privateKey) {
    const header = {
        "alg": "RS256",
        "typ": "JWT"
    };

    const base64UrlEncode = (data) => {
        return btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    };

    const token = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

    const encoder = new TextEncoder();
    const data = encoder.encode(token);

    const privateKeyJwk = await importPKCS8(privateKey);
    const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        privateKeyJwk,
        data
    );

    const signatureBase64Url = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    return `${token}.${signatureBase64Url}`;
}

// Helper function to import a private key from PKCS#8 format
async function importPKCS8(pem) {
    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const pemBody = pem.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

    return await crypto.subtle.importKey(
        "pkcs8",
        binaryDer,
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256"
        },
        true,
        ["sign"]
    );
}

// Helper function to get the access token from Google
async function getAccessToken(jwt) {
    const response = await fetch("https://www.googleapis.com/oauth2/v4/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const data = await response.json();
    if (data.error) {
        throw new Error(`Failed to get access token: ${data.error_description}`);
    }
    return data.access_token;
}

export default {
    async fetch(request, env) {
        // Only accept POST requests
        if (request.method !== 'POST') {
            return new Response("Method Not Allowed", { status: 405 });
        }

        try {
            // --- Authentication ---
            const headers = request.headers;
            const username = headers.get('username');
            const password = headers.get('password');

            const expectedUsername = env.WORKER_USERNAME;
            const expectedPassword = env.WORKER_PASSWORD;

            if (username !== expectedUsername || password !== expectedPassword) {
                return new Response("Unauthorized", { status: 401 });
            }
            // --- End of Authentication ---

            // Parse the incoming request body from the bot connector
            const requestBody = await request.json();

            // Extract core variables
            const userMessage = requestBody.inputMessage.text;
            const languageCode = requestBody.languageCode || 'en-US';
            const sessionId = requestBody.botSessionId;
            let botContexts = requestBody.botContexts || []; 

            if (!userMessage) {
                return new Response("No user message found.", { status: 400 });
            }

            // Get Dialogflow credentials
            if (!env.DIALOGFLOW_CREDENTIALS) {
                throw new Error('DIALOGFLOW_CREDENTIALS environment variable is not set.');
            }
            let credentials = JSON.parse(env.DIALOGFLOW_CREDENTIALS);
            
            const projectId = credentials.project_id;
            const privateKey = credentials.private_key.replace(/\\n/g, '\n');
            const clientEmail = credentials.client_email;

            // Generate token (omitted logging for brevity)
            const payload = {
                "iss": clientEmail,
                "scope": "https://www.googleapis.com/auth/cloud-platform",
                "aud": "https://www.googleapis.com/oauth2/v4/token",
                "exp": Math.floor(Date.now() / 1000) + 3600,
                "iat": Math.floor(Date.now() / 1000)
            };
            const jwt = await createJWT(payload, privateKey);
            const accessToken = await getAccessToken(jwt);

            // --- Start: Fallback Counter Context Setup ---
            const FALLBACK_CONTEXT_DISPLAY_NAME = 'fallback_counter'; 
            const FALLBACK_CONTEXT_FULL_NAME = `projects/${projectId}/agent/sessions/${sessionId}/contexts/${FALLBACK_CONTEXT_DISPLAY_NAME}`;
            let fallbackCount = 0;
            let existingFallbackContext = null;

            // Find existing fallback context and read the count
            // We search by the DISPLAY NAME since Genesys often only passes back contexts relevant to the current session path
            existingFallbackContext = botContexts.find(context => 
                context.name.endsWith(FALLBACK_CONTEXT_DISPLAY_NAME)
            );

            if (existingFallbackContext && existingFallbackContext.parameters && existingFallbackContext.parameters.count) {
                // Parse count from string, or default to 0 if invalid
                const parsedCount = parseInt(existingFallbackContext.parameters.count, 10);
                fallbackCount = isNaN(parsedCount) ? 0 : parsedCount;
            }
            // --- End: Fallback Counter Context Setup ---


            // The Dialogflow REST API endpoint
            const url = `https://dialogflow.googleapis.com/v2/projects/${projectId}/agent/sessions/${sessionId}:detectIntent`;

            // The Dialogflow request
            const dialogflowRequest = {
                queryInput: {
                    text: {
                        text: userMessage,
                        languageCode: languageCode,
                    },
                },
                queryParams: {
                    // Send all existing contexts back
                    contexts: botContexts 
                }
            };

            // Send the query to Dialogflow (omitted logging for brevity)
            const response = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(dialogflowRequest) });

            if (!response.ok) {
                const errorBody = await response.json();
                throw new Error(`Dialogflow API error: ${response.status} ${response.statusText} - ${errorBody.error.message}`);
            }

            const dialogflowResponse = await response.json();
            const result = dialogflowResponse.queryResult;
            
            const dialogflowIntent = result.intent ? result.intent.displayName : 'UNKNOWN';
            const dialogflowConfidence = result.intentDetectionConfidence || 0;
            let outputContexts = result.outputContexts || [];
            let dialogflowReply = result.fulfillmentText || 'No response from Dialogflow.';
            let botState = "MOREDATA";

            // --- Start: Post-processing Fallback Logic ---
            if (dialogflowIntent === "Default Fallback Intent") {
                // This is a failed attempt. Increment the counter.
                fallbackCount++;

                // Remove the old fallback context if it exists to ensure we only have one copy in the output
                outputContexts = outputContexts.filter(context => 
                    !context.name.endsWith(FALLBACK_CONTEXT_DISPLAY_NAME)
                );

                if (fallbackCount >= 3) {
                    // *** 3rd strike: END THE CONVERSATION ***
                    botState = "COMPLETE";
                    dialogflowReply = "I'm sorry, I cannot understand your request after multiple attempts. I am now closing this conversation. Please contact a human agent if you require further assistance.";

                    // Ensure the context is removed from the output by setting lifespan to 0
                    const finalContext = {
                        name: FALLBACK_CONTEXT_FULL_NAME,
                        lifespanCount: 0,
                        parameters: {
                            count: fallbackCount.toString()
                        }
                    };
                    outputContexts.push(finalContext);

                } else {
                    // *** Not 3 strikes: Send generic message and update counter context ***
                    // Ensure the generic reply is used
                    dialogflowReply = "I'm sorry, I'm still having trouble understanding. Could you please try rephrasing?";

                    // Prepare the updated fallback context object for the output
                    const updatedFallbackContext = {
                        // Crucial: Use the FULL context name path for the output contexts
                        name: FALLBACK_CONTEXT_FULL_NAME,
                        lifespanCount: 1, // Keep context alive for the next turn
                        parameters: {
                            count: fallbackCount.toString()
                        }
                    };

                    // Add the updated context to the output contexts array
                    outputContexts.push(updatedFallbackContext);
                }
            } else if (existingFallbackContext) {
                // A valid intent was matched. Reset the counter by setting lifespan to 0.
                
                // Remove the old fallback context before pushing the reset one
                outputContexts = outputContexts.filter(context => 
                    !context.name.endsWith(FALLBACK_CONTEXT_DISPLAY_NAME)
                );

                const resetContext = {
                    name: FALLBACK_CONTEXT_FULL_NAME,
                    lifespanCount: 0,
                    parameters: {
                        count: "0"
                    }
                };
                outputContexts.push(resetContext);
            }
            // --- End: Post-processing Fallback Logic ---


            // Build the final response
            const finalResponse = {
                "replymessages": [
                    {
                        "type": "Text",
                        "text": dialogflowReply
                    }
                ],
                "intent": dialogflowIntent,
                "confidence": dialogflowConfidence,
                "botContexts": outputContexts,
                "botState": botState
            };

            // Return the JSON response with a 200 OK status
            return new Response(JSON.stringify(finalResponse), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

        } catch (e) {
            // Catch any errors that might occur
            return new Response(`Error processing request: ${e.message}`, { status: 500 });
        }
    },
};
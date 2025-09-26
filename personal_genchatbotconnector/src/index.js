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

    const signatureBase64Url = btoa(String.fromCharCode(...new Uint8array(signature)))
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

            console.log('Worker Username:', expectedUsername);
            console.log('Worker Password:', expectedPassword ? 'Exists' : 'Does not exist');

            if (username !== expectedUsername || password !== expectedPassword) {
                return new Response("Unauthorized", { status: 401 });
            }
            // --- End of Authentication ---

            // Parse the incoming request body from the bot connector
            const requestBody = await request.json();
            console.log('Received message from bot connector:', JSON.stringify(requestBody, null, 2));

            // Extract the user's message and language code
            const userMessage = requestBody.inputMessage.text;
            const languageCode = requestBody.languageCode || 'en-US'; // Use the languageCode from the request or default
            const sessionId = requestBody.botSessionId; // Use botSessionId as the session ID
            const botContexts = requestBody.botContexts || []; // Get existing contexts from the request

            console.log('User Message:', userMessage);
            console.log('Session ID:', sessionId);
            console.log('Bot Contexts:', JSON.stringify(botContexts, null, 2));

            if (!userMessage) {
                return new Response("No user message found.", { status: 400 });
            }

            // Get Dialogflow credentials from environment variables.
            // NOTE: Make sure to set DIALOGFLOW_CREDENTIALS as a secret in your Cloudflare Worker.
            console.log('Checking DIALOGFLOW_CREDENTIALS...');
            if (!env.DIALOGFLOW_CREDENTIALS) {
                throw new Error('DIALOGFLOW_CREDENTIALS environment variable is not set.');
            }

            let credentials;
            try {
                credentials = JSON.parse(env.DIALOGFLOW_CREDENTIALS);
            } catch (parseError) {
                console.error('Failed to parse DIALOGFLOW_CREDENTIALS JSON:', parseError.message);
                return new Response(`Error: Failed to parse credentials. Details: ${parseError.message}`, { status: 500 });
            }

            const projectId = credentials.project_id;
            const privateKey = credentials.private_key.replace(/\\n/g, '\n');
            const clientEmail = credentials.client_email;

            // Generate an access token from the private key
            const payload = {
                "iss": clientEmail,
                "scope": "https://www.googleapis.com/auth/cloud-platform",
                "aud": "https://www.googleapis.com/oauth2/v4/token",
                "exp": Math.floor(Date.now() / 1000) + 3600,
                "iat": Math.floor(Date.now() / 1000)
            };
            const jwt = await createJWT(payload, privateKey);
            const accessToken = await getAccessToken(jwt);

            console.log('Dialogflow Project ID:', projectId);

            // --- Start: Fallback Counter Logic ---
            let fallbackCount = 0;
            const fallbackContextName = `projects/${projectId}/agent/sessions/${sessionId}/contexts/fallback_counter`;

            const existingFallbackContext = botContexts.find(context => context.name === fallbackContextName);
            if (existingFallbackContext && existingFallbackContext.parameters && existingFallbackContext.parameters.fallback_count) {
                fallbackCount = existingFallbackContext.parameters.fallback_count;
            }

            console.log('Current fallback count:', fallbackCount);

            // --- End: Fallback Counter Logic ---

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
                // Pass the contexts back to Dialogflow
                queryParams: {
                    contexts: botContexts
                }
            };

            console.log('Sending request to Dialogflow with payload:', JSON.stringify(dialogflowRequest, null, 2));

            // Send the query to Dialogflow using the fetch API
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(dialogflowRequest)
            });

            // --- START: New Error Handling for API Response ---
            if (!response.ok) {
                const errorBody = await response.json();
                console.error('Dialogflow API returned an error:', JSON.stringify(errorBody, null, 2));
                // Throw an error to be caught by the main catch block
                throw new Error(`Dialogflow API error: ${response.status} ${response.statusText}`);
            }
            // --- END: New Error Handling ---

            const dialogflowResponse = await response.json();
            const result = dialogflowResponse.queryResult;

            // Log the Dialogflow response for debugging
            console.log('Dialogflow response:', JSON.stringify(dialogflowResponse, null, 2));

            // Get the fulfillment text from Dialogflow's response
            const dialogflowReply = result.fulfillmentText || 'No response from Dialogflow.';
            const dialogflowIntent = result.intent ? result.intent.displayName : 'UNKNOWN';
            const dialogflowConfidence = result.intentDetectionConfidence || 0;
            let outputContexts = result.outputContexts || [];
            
            // --- Start: Post-processing fallback logic ---
            let endConversation = false;
            let finalReply = dialogflowReply;

            // Check if the matched intent is the fallback intent.
            if (dialogflowIntent === "Default Fallback Intent") {
                // Check if the previous conversation had an active context
                const previousContext = botContexts.find(context => context.lifespanCount > 0);

                if (fallbackCount >= 2) { // End the conversation after 3 total fallbacks (0, 1, 2)
                    endConversation = true;
                    finalReply = "I'm sorry, I am unable to help with that. Please contact a human agent for assistance. Goodbye!";
                } else {
                    fallbackCount++;
                    finalReply = "I'm sorry, I'm having trouble understanding. Could you please try rephrasing?";

                    // If there was a previous context, re-apply it to the next turn.
                    if (previousContext) {
                        outputContexts.push({
                            name: previousContext.name,
                            lifespanCount: 1, // Reset lifespan to 1 to keep it active for the next turn
                            parameters: previousContext.parameters
                        });
                    }
                    
                    // Add the fallback counter context
                    outputContexts.push({
                        name: fallbackContextName,
                        lifespanCount: 1,
                        parameters: {
                            fallback_count: fallbackCount
                        }
                    });
                }
            } else {
                 // Reset the fallback counter if a valid intent is matched
                 fallbackCount = 0;
            }

            // --- End: Post-processing fallback logic ---
            
            // Build the response in the format required by the Genesys Cloud Bot Connector
            const finalResponse = {
                "replymessages": [
                    {
                        "type": "Text",
                        "text": finalReply
                    }
                ],
                "intent": dialogflowIntent,
                "confidence": dialogflowConfidence,
                "botContexts": outputContexts,
                "botState": endConversation ? "COMPLETE" : "MOREDATA"
            };

            console.log('Final response sent to Genesys Cloud:', JSON.stringify(finalResponse, null, 2));

            // Return the JSON response with a 200 OK status
            return new Response(JSON.stringify(finalResponse), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

        } catch (e) {
            // Catch any errors that might occur and log the full message
            console.error('Error processing request:', e.message);
            return new Response(`Error: ${e.message}`, { status: 500 });
        }
    },
};

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
            // Get all contexts provided by Genesys (essential for continuity)
            let botContexts = requestBody.botContexts || []; 

            if (!userMessage && requestBody.parameters && requestBody.parameters.initialEventName) {
                // Special case for initial request using an event name instead of text
                // Dialogflow uses a 'WELCOME' event for the first message, which should be handled by the flow author
            } else if (!userMessage) {
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
                    // Send all existing contexts back to Dialogflow for memory
                    contexts: botContexts 
                }
            };

            // Send the query to Dialogflow 
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
            
            // Simplified logic: Assume MOREDATA unless the intent is marked for session end (which should be configured in DF)
            let botState = "MOREDATA"; 
            
            // If the intent is marked to end the session (optional check, depends on DF config)
            if (result.intent && result.intent.endInteraction) {
                 botState = "COMPLETE";
            }

            // --- IMPORTANT: Ensure Fallback returns MOREDATA (loop continues) ---
            // If Dialogflow fails to match an intent, it will return Default Fallback Intent.
            // We set the botState to MOREDATA to ensure the Architect loop continues.
            if (dialogflowIntent === "Default Fallback Intent") {
                 botState = "MOREDATA"; 
                 dialogflowReply = dialogflowReply || "I'm sorry, I'm still having trouble understanding. Could you please try rephrasing?";
            }
            // --- End: Simplified Logic ---


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
                "botContexts": outputContexts, // Pass contexts back for conversational memory
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
            // Note: Returning FAILED state would require adjusting the final response structure
            return new Response(`Error processing request: ${e.message}`, { status: 500 });
        }
    },
};
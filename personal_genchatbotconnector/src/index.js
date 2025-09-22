import { SessionsClient } from '@google-cloud/dialogflow';

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

      // Extract the user's message from the specified schema
      const userMessage = requestBody.inputMessage.text;
      const sessionId = requestBody.botSessionId; // Use botSessionId as the session ID
      
      console.log('User Message:', userMessage);
      console.log('Session ID:', sessionId);

      if (!userMessage) {
        return new Response("No user message found.", { status: 400 });
      }
      
      // Get Dialogflow credentials from environment variables.
      // NOTE: Make sure to set DIALOGFLOW_CREDENTIALS as a secret in your Cloudflare Worker.
      const credentials = JSON.parse(env.DIALOGFLOW_CREDENTIALS);
      const projectId = credentials.project_id;
      
      console.log('Dialogflow Project ID:', projectId);

      // Initialize the Dialogflow client with service account credentials
      const sessionClient = new SessionsClient({
          projectId: projectId,
          credentials: {
              client_email: credentials.client_email,
              private_key: credentials.private_key,
          }
      });
      
      const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);
      
      // The Dialogflow request
      const dialogflowRequest = {
        session: sessionPath,
        queryInput: {
          text: {
            text: userMessage,
            languageCode: 'en-US',
          },
        },
      };
      
      console.log('Sending request to Dialogflow with payload:', JSON.stringify(dialogflowRequest, null, 2));

      // Send the query to Dialogflow and get the response
      const responses = await sessionClient.detectIntent(dialogflowRequest);
      const result = responses[0].queryResult;

      // Log the Dialogflow response for debugging
      console.log('Dialogflow response:', JSON.stringify(responses, null, 2));

      // Get the fulfillment text from Dialogflow's response
      const dialogflowReply = result.fulfillmentText || 'No response from Dialogflow.';

      // Build the response in the format required by the Genesys Cloud Bot Connector
      const response = {
        "replymessages": [
          {
            "type": "Text",
            "text": dialogflowReply
          }
        ]
      };

      // Return the JSON response with a 200 OK status
      return new Response(JSON.stringify(response), {
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
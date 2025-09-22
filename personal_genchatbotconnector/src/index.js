import { SessionsClient } from '@google-cloud/dialogflow';

export default {
  async fetch(request, env) {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response("Method Not Allowed", { status: 405 });
    }

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

    try {
      // Parse the incoming request body from the bot connector
      const requestBody = await request.json();
      console.log('Received message from bot connector:', JSON.stringify(requestBody, null, 2));

      // Extract the user's message from the specified schema
      const userMessage = requestBody.inputMessage.text;
      const sessionId = requestBody.botSessionId; // Use botSessionId as the session ID

      if (!userMessage) {
        return new Response("No user message found.", { status: 400 });
      }

      // Initialize the Dialogflow client. You will need to configure your environment with
      // your Google Cloud project credentials.
      const projectId = env.GOOGLE_CLOUD_PROJECT_ID;
      const sessionClient = new SessionsClient();
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

      // Send the query to Dialogflow and get the response
      const responses = await sessionClient.detectIntent(dialogflowRequest);
      const result = responses[0].queryResult;

      // Log the Dialogflow response for debugging
      console.log('Dialogflow response:', JSON.stringify(result, null, 2));

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
      // Catch any errors that might occur
      console.error('Error processing request:', e.message);
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};
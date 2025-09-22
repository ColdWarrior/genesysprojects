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

    // Use environment variables for credentials
    const expectedUsername = env.WORKER_USERNAME;
    const expectedPassword = env.WORKER_PASSWORD; 

    if (username !== expectedUsername || password !== expectedPassword) {
      return new Response("Unauthorized", { status: 401 });
    }
    // --- End of Authentication ---

    try {
      // Parse the incoming request body
      const requestBody = await request.json();

      // Log the incoming message for debugging purposes
      console.log('Received message:', JSON.stringify(requestBody));

      // Build the response in the format required by the Genesys Cloud Bot Connector
      const response = {
        "replymessages": [
          {
            "type": "Text",
            "text": "Hello, I am a simple bot connector!"
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
      // Catch any errors that might occur during parsing or processing
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};
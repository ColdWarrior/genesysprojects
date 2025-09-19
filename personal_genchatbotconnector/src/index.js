export default {
  async fetch(request) {
    // Only process POST requests, as required by the Genesys Bot Connector.
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Read the JSON body sent by Genesys.
      const requestBody = await request.json();

      // Log the incoming message to the console for debugging.
      console.log('Received message:', requestBody);
      

      // Here, you would implement your bot's logic.
      // This is the "translation layer" that would communicate with your bot.
      // For this example, we will just send a simple JSON response back.

      const responseBody = {
        messages: [{
          type: "Text",
          text: "Hello, I am a simple bot connector!",
          agent: {
            "name": "Cloudflare Bot"
          }
        }]
      };

      // Send the response back to Genesys.
      return new Response(JSON.stringify(responseBody), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      // Handle any errors that occur during the process.
      return new Response(`Error processing request: ${err.message}`, { status: 500 });
    }
  }
};
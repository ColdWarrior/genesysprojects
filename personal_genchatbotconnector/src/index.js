export default {
  async fetch(request, env) {
    // Check for POST method and enforce Basic Authentication
    if (request.method === 'POST') {
      const authHeader = request.headers.get('Authorization');
      
      // Check if the Authorization header is present
      if (!authHeader) {
        return new Response('Unauthorized: Missing Authorization Header', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Basic realm="Secure Area"',
          },
        });
      }

      // Decode the Base64 credentials
      const [scheme, encoded] = authHeader.split(' ');
      if (scheme !== 'Basic' || !encoded) {
        return new Response('Unauthorized: Invalid Authorization Header', {
          status: 401,
        });
      }
      
      const credentials = atob(encoded);
      const [username, password] = credentials.split(':');
      
      // Compare the credentials to the secure environment variables
      if (username !== env.WORKER_USERNAME || password !== env.WORKER_PASSWORD) {
        return new Response('Unauthorized: Invalid Credentials', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Basic realm="Secure Area"',
          },
        });
      }

      // If authentication is successful, proceed with the original logic
      try {
        const requestBody = await request.json();
        console.log('Received message:', requestBody);
        
        const responseBody = {
		  "replymessages": [
			{
			  "type": "Text",
			  "text": "Hello, I am a simple bot connector!"
			}
		  ]
		};

        return new Response(JSON.stringify(responseBody), {
          headers: {
            'Content-Type': 'application/json'
          }
        });

      } catch (err) {
        return new Response(`Error processing request: ${err.message}`, { status: 500 });
      }
    }
    
    // Default response for non-POST requests
    return new Response('Method not allowed', { status: 405 });
  }
};
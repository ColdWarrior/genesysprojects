export default {
  async fetch(request, env) {
    // This is a stripped-down version to test if the worker is executing code at all.
    console.log('Worker is running!');

    return new Response('Test OK', { status: 200 });
  },
};
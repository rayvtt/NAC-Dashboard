export default {
  async fetch(request) {
    const resp = await fetch(
      'https://raw.githubusercontent.com/rayvtt/NAC-Dashboard/main/index.html',
      { cf: { cacheTtl: 300 } }
    );
    return new Response(resp.body, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

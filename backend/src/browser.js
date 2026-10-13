// Starts a headless Chrome through Cloudflare Browser Rendering.
// Kept in its own file so tests can run the bot with a local browser instead.
import puppeteer from '@cloudflare/puppeteer';

export async function launchBrowser(env) {
  if (!env.BROWSER) throw new Error('The BROWSER binding is missing from wrangler.toml.');
  return puppeteer.launch(env.BROWSER, { keep_alive: 120000 });
}

import type { AuthProviderId } from "../config";

/** Browser half of Better Auth's official desktop transfer; OAuth remains with Better Auth. */
export function desktopAuthPage(
  request: Request,
  providers: readonly AuthProviderId[],
): Response {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  let redirect: URL;
  try {
    redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  } catch {
    return new Response("Invalid desktop callback.", { status: 400 });
  }
  if (
    !providers.some((value) => value === provider) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    redirect.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(redirect.hostname) ||
    !redirect.port ||
    redirect.pathname !== "/organization-auth/callback" ||
    redirect.search ||
    redirect.hash ||
    redirect.username ||
    redirect.password
  ) {
    return new Response("Invalid desktop sign-in configuration.", {
      status: 400,
    });
  }
  const config = JSON.stringify({
    provider,
    state,
    challenge,
    redirect: redirect.href,
    callback: url.href,
  }).replaceAll("<", "\\u003c");
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in to OpenBot</title></head><body><main><h1>Sign in to OpenBot</h1><p id="status">Continue with your organization account to return to OpenBot.</p><button id="continue">Continue</button></main><script nonce="${nonce}">
const config=${config};
const status=document.getElementById('status');
const button=document.getElementById('continue');
const query=new URLSearchParams({client_id:'openbot-desktop',state:config.state,code_challenge:config.challenge});
async function proceed(){button.disabled=true;try{
 const transfer=await fetch('/api/auth/electron/transfer-user?'+query,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'});
 if(transfer.ok){const grant=await transfer.json();if(typeof grant.electron_authorization_code!=='string')throw new Error('Sign-in did not return a code.');const target=new URL(config.redirect);target.searchParams.set('code',grant.electron_authorization_code);target.searchParams.set('state',config.state);location.replace(target.href);return;}
 if(transfer.status!==401)throw new Error('Your organization could not authorize this sign-in.');
 const response=await fetch('/api/auth/sign-in/social?'+query,{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({provider:config.provider,callbackURL:config.callback})});
 const result=await response.json();if(!response.ok||typeof result.url!=='string')throw new Error('Your organization could not start sign-in.');location.assign(result.url);
}catch(error){status.textContent=error.message;button.disabled=false;}}
button.addEventListener('click',proceed);
</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

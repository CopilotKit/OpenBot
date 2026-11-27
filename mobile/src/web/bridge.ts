/**
 * The script the app puts in the web app's page (./shell.tsx), and the messages the page sends back.
 *
 * The web view is signed in by the page's own session, and the app holds no sign-in of its own. So what the
 * app has to tell OpenBot, it asks the page to tell: which phone gets this person's notifications. The script
 * does four things, on the web app's own address and nowhere else:
 *
 * - says who is signed in (`GET /api/me`), when the page loads and after every sign-in or sign-out;
 * - registers this phone for push notifications in the organization the person works in, when the app asks;
 * - takes the phone off again before a sign-out is sent, because OpenBot gives a phone to the next person only
 *   once its owner signed out on it;
 * - hides the links that start a payment (./navigation.ts, PURCHASE_PATHS).
 *
 * Every request is one the API already has (docs/api-and-migrations.md): nothing here is new to the server.
 *
 * Imports nothing that needs a phone, so it can be tested: tests/web-bridge.test.ts runs the script in a page
 * made of fakes.
 */
import { PURCHASE_PATHS } from "./navigation";

/** The phone, as OpenBot registers it for push notifications. */
export type Phone = {
  /** The id this install made for itself. */
  id: string;
  /** Expo's push token. */
  token: string;
  /** The Expo project the token belongs to. */
  projectId: string;
  platform: "ios" | "android";
};

/** What the page tells the app. */
export type PageMessage =
  | { type: "session"; signedIn: boolean; person?: string }
  | { type: "registered"; ok: boolean; status?: number }
  | { type: "removed"; ok: boolean };

/**
 * The API's addresses the script asks, written as the API's spec writes them. The page has no generated client, so
 * they are named here, and tests/web-bridge.test.ts holds each one to the client generated from the spec
 * (../api/generated): an address the API moves fails there, not on a phone.
 */
export const ORGANIZATIONS_PATH = "/api/v2/people/me/organizations";
export const DEVICE_PATH =
  "/api/v2/organizations/{organizationId}/people/me/devices/{deviceId}";

/** The name the page's side goes by, on `window`. */
const GLOBAL = "__openbotMobile";

/**
 * Read a message the web view received. Null for anything that is not one of ours: a page can post whatever it
 * likes, and the app acts only on these three, from the web app's own address (the shell checks the address).
 */
export function readPageMessage(data: unknown): PageMessage | null {
  if (typeof data !== "string" || data.length > 2_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.openbot !== 1) return null;
  if (message.type === "session" && typeof message.signedIn === "boolean")
    return {
      type: "session",
      signedIn: message.signedIn,
      ...(typeof message.person === "string" && message.person.length <= 200
        ? { person: message.person }
        : {}),
    };
  if (message.type === "registered" && typeof message.ok === "boolean")
    return {
      type: "registered",
      ok: message.ok,
      ...(typeof message.status === "number" ? { status: message.status } : {}),
    };
  if (message.type === "removed" && typeof message.ok === "boolean")
    return { type: "removed", ok: message.ok };
  return null;
}

/** Ask the page who is signed in. */
export const PROBE = `window.${GLOBAL}&&window.${GLOBAL}.probe();true;`;

/** Ask the page to register this phone, and to take it off again at sign-out. */
export function registerCall(phone: Phone): string {
  return `window.${GLOBAL}&&window.${GLOBAL}.register(${JSON.stringify(phone)});true;`;
}

/** Tell the page which phone to take off at sign-out, on a page loaded after the phone was registered. */
export function holdCall(id: string): string {
  return `window.${GLOBAL}&&window.${GLOBAL}.hold(${JSON.stringify(id)});true;`;
}

/**
 * The script, for the web app at `origin`. `client` is the app's `OpenBot-Client` value (../release.ts), named
 * on the requests the script makes itself; the page's own requests stay the web app's.
 */
export function bridgeScript(options: {
  origin: string;
  client?: string;
}): string {
  const hidden = PURCHASE_PATHS.map((path) => `a[href*="${path}"]`).join(",");
  // No callout on a long press and no bounce past the page's ends: the page sits in an app, not a browser tab.
  const css = `${hidden}{display:none!important}html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}body{-webkit-touch-callout:none;overscroll-behavior:none}`;
  return `(function(){
var ORIGIN=${JSON.stringify(options.origin)},CLIENT=${JSON.stringify(options.client ?? "")},CSS=${JSON.stringify(css)},LIST=${JSON.stringify(ORGANIZATIONS_PATH)},DEVICE=${JSON.stringify(DEVICE_PATH)};
if(window.${GLOBAL}||location.origin!==ORIGIN||typeof window.fetch!=="function")return;
var send=window.fetch.bind(window),device=null;
function post(m){try{m.openbot=1;window.ReactNativeWebView.postMessage(JSON.stringify(m));}catch(e){}}
function key(){try{return crypto.randomUUID();}catch(e){return Date.now()+"-"+Math.random().toString(16).slice(2);}}
function headers(write){var h={accept:"application/json"};if(CLIENT)h["OpenBot-Client"]=CLIENT;if(write){h["content-type"]="application/json";h["idempotency-key"]=key();}return h;}
function page(cursor){return send(LIST+(cursor?"?cursor="+encodeURIComponent(cursor):""),{credentials:"include",headers:headers(false)}).then(function(r){if(!r.ok)throw new Error(String(r.status));return r.json();});}
function organizations(){var all=[];function next(cursor,left){return page(cursor).then(function(b){if(b&&Array.isArray(b.organizations))all=all.concat(b.organizations);return b&&typeof b.nextCursor==="string"&&b.nextCursor&&left>0?next(b.nextCursor,left-1):all;});}return next(null,20);}
function place(organization,id){return DEVICE.replace("{organizationId}",encodeURIComponent(organization)).replace("{deviceId}",encodeURIComponent(id));}
function probe(){return send("/api/me",{credentials:"include",headers:headers(false)}).then(function(r){if(r.status===401){post({type:"session",signedIn:false});return;}if(!r.ok)return;return r.json().then(function(b){var id=b&&b.user&&typeof b.user.id==="string"?b.user.id:null;post(id?{type:"session",signedIn:true,person:id}:{type:"session",signedIn:false});});}).catch(function(){});}
function register(phone){device=phone.id;return organizations().then(function(list){var one=null;for(var i=0;i<list.length;i++)if(list[i]&&list[i].active){one=list[i];break;}one=one||list[0];if(!one||typeof one.id!=="string")throw new Error("none");return send(place(one.id,phone.id),{method:"PUT",credentials:"include",headers:headers(true),body:JSON.stringify({token:phone.token,projectId:phone.projectId,platform:phone.platform})});}).then(function(r){post({type:"registered",ok:r.ok,status:r.status});}).catch(function(){post({type:"registered",ok:false});});}
function remove(){var id=device;if(!id)return Promise.resolve();return organizations().then(function(list){return Promise.all(list.map(function(one){return send(place(one.id,id),{method:"DELETE",credentials:"include",headers:headers(true)}).catch(function(){});}));}).then(function(){device=null;post({type:"removed",ok:true});}).catch(function(){post({type:"removed",ok:false});});}
window.fetch=function(input,init){var auth=false,out=false;try{var u=new URL(typeof input==="string"?input:(input&&input.url)||String(input),location.href);var m=String((init&&init.method)||(input&&input.method)||"GET").toUpperCase();auth=u.origin===ORIGIN&&u.pathname.indexOf("/api/auth/")===0&&m!=="GET";out=auth&&u.pathname==="/api/auth/sign-out";}catch(e){}
var go=function(){return send(input,init);};var sent=out&&device?remove().then(go,go):go();if(auth)sent.then(function(){setTimeout(probe,0);},function(){});return sent;};
function style(){try{var s=document.createElement("style");s.textContent=CSS;(document.head||document.documentElement).appendChild(s);}catch(e){}}
if(document.documentElement)style();else document.addEventListener("DOMContentLoaded",style);
window.addEventListener("pageshow",function(e){if(e&&e.persisted)probe();});
window.${GLOBAL}={probe:probe,register:register,hold:function(id){device=id;}};
probe();
})();true;`;
}

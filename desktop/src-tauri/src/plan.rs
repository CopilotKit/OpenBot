//! Signing in to a Claude plan, so nobody has to hold an API key.
//!
//! This is the default path on the model screen: anybody with a key and a base URL to hand is a
//! developer, and everybody else has a plan they already pay for.
//!
//! ANTHROPIC'S OWN CLI DOES THE FLOW. It starts the OAuth, shows the consent URL, takes the code
//! back and exchanges it. Reimplementing that here would mean holding somebody else's OAuth client
//! id, redirect and PKCE details and re-shipping them whenever any of it moves. Driving the
//! vendor's command is the same call as reaching Mastra through Mastra's own bridge.
//!
//! AND NOTHING HAS TO BE INSTALLED FOR IT. The Claude Agent SDK ships a self-contained `claude`
//! binary inside the Python package, so the harness image OpenBot already pulls has a working CLI
//! at `_bundled/claude` and the person's machine needs no Node, no npm and no CLI of their own.
//!
//! The flow runs in that container, which is why the code is pasted rather than redirected. The
//! CLI's local callback server is unreachable from a browser outside the container, so it falls
//! back to `code=true` and prints a code for the person to bring back. Anthropic documents that
//! fallback for exactly this case: "common in WSL2, SSH sessions, and containers".

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// The image whose bundled CLI runs the sign-in.
///
/// The Claude Agent SDK harness, used here as a tool rather than as a Bot: it is simply the image
/// that carries Anthropic's own CLI, so nothing has to be installed on the person's machine. Pinned
/// by the release like every other image; the tag here is what a development tree builds.
pub const SIGN_IN_IMAGE: &str = "openbot-harness-claude-sdk:test";

/// Where the SDK keeps the binary it bundles.
///
/// A path inside the harness image rather than anything on the person's machine. It moves when the
/// package is restructured, which is why the failure to find it is reported as itself rather than
/// as a spawn error.
pub const BUNDLED_CLI: &str =
    "/usr/local/lib/python3.12/site-packages/claude_agent_sdk/_bundled/claude";

/// The start of a plan token, which is what tells it apart from an API key.
///
/// Only the prefix lives here. A key and a plan token are both opaque strings and only this
/// distinguishes them, and taking an API key for a plan token would write the one credential the
/// plan path exists to avoid.
const PLAN_TOKEN_PREFIX: &str = concat!("sk", "-ant-oat");

/// Everything the terminal drew, with the escapes taken out.
///
/// The CLI is a TUI: it writes cursor moves, colours, and OSC-8 hyperlinks, and it line-wraps the
/// URL it prints so the visible text is not the URL. Reading it means stripping first.
fn plain(output: &str) -> String {
    let mut out = String::with_capacity(output.len());
    let mut chars = output.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // CSI: ESC [ … final byte in @-~
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
            continue;
        }
        // OSC: ESC ] … terminated by BEL or ESC \
        if chars.peek() == Some(&']') {
            chars.next();
            while let Some(c) = chars.next() {
                if c == '\u{7}' {
                    break;
                }
                if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                    chars.next();
                    break;
                }
            }
            continue;
        }
        /*
         * Everything else: ESC, then zero or more intermediate bytes (0x20-0x2F), then one final
         * byte (0x30-0x7E). `ESC ( B` is the common one — a charset designation — and it is three
         * bytes, not two. Dropping a fixed pair left its `B` in the text, which is the sort of
         * thing that turns a token scan into a near-miss.
         */
        while let Some(&c) = chars.peek() {
            chars.next();
            if !(' '..='/').contains(&c) {
                break;
            }
        }
    }
    out
}

/**
The consent URL the CLI wants a browser opened on.

Taken from the OSC-8 hyperlink rather than from the visible text, and that is the whole point of
this function. The CLI prints the URL twice: once as the hyperlink's target, which is intact, and
once as wrapped display text, which has the terminal's line breaks spliced into the middle of the
query string. Reading the visible copy yields a URL that looks right, opens, and fails, because
`state` and `code_challenge` have had characters inserted into them.
*/
pub fn authorize_url_in(output: &str) -> Option<String> {
    // ESC ] 8 ; <params> ; <uri> ST — the uri is the second `;`-separated field.
    for start in find_all(output, "\u{1b}]8;") {
        let after = &output[start + 4..];
        let Some(semicolon) = after.find(';') else {
            continue;
        };
        let uri = &after[semicolon + 1..];
        let end = uri
            .find('\u{7}')
            .or_else(|| uri.find('\u{1b}'))
            .unwrap_or(uri.len());
        let uri = uri[..end].trim();
        if uri.contains("/oauth/authorize") {
            return Some(uri.to_string());
        }
    }
    None
}

fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = haystack[from..].find(needle) {
        found.push(from + at);
        from += at + needle.len();
    }
    found
}

/// Whether the CLI is waiting for the code from the browser.
///
/// Asked before writing, so a code is never typed into a prompt that is not there: written early it
/// is consumed by whatever the TUI is drawing and the flow stalls with no sign of why.
pub fn wants_the_code(output: &str) -> bool {
    /*
     * Compared with the spaces taken out of both sides, because the CLI does not use spaces.
     *
     * It positions every word with a cursor-column escape instead — `Paste\u{1b}[7Gcode` and so on
     * — so stripping the escapes leaves "Pastecodehereifprompted" and a match on the phrase as
     * written never fires. This cost a live sign-in: the code was handed over, and the flow sat in
     * the wrong wait until it timed out, with the prompt plainly on screen the whole time.
     */
    let squashed: String = plain(output)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    squashed.contains("Pastecodehere")
}

/**
Whether the endpoint refused the code.

Its own answer because the alternative is waiting out the timeout and then saying something vague.
The CLI prints `OAuth error: …` and offers to retry, so it stays alive and there is nothing further
to wait for: the code is spent either way and the flow has to start again.
*/
pub fn refused_the_code(output: &str) -> bool {
    // Whitespace-insensitive, for the same reason as the prompt: the words are cursor-positioned
    // rather than spaced, so the phrase as written never appears in the stripped text.
    let squashed: String = plain(output)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    squashed.contains("OAuthError:") || squashed.contains("OAutherror:")
}

/**
The token in whatever the command printed.

Pure and separate from the running of it, because the shape of this output is the thing here most
likely to change without warning: it is a human-facing CLI, not an API.

Scanned for by prefix rather than by position. Matching "the last line", or the text after a label,
breaks the first time a hint or a colour is added, and breaking here means telling somebody who
approved in their browser that it failed.
*/
pub fn token_in(output: &str) -> Option<String> {
    plain(output)
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .map(|word| word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_'))
        .find(|word| word.starts_with(PLAN_TOKEN_PREFIX) && word.len() > 30)
        .map(str::to_string)
}

/// A sign-in in progress: the CLI is running and waiting for the code from the browser.
///
/// Held rather than completed in one call because a person has to go and approve in a browser in
/// the middle of it. One call starts it and returns the URL; a second brings the code back.
pub struct SigningIn {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn std::io::Write + Send>,
    output: std::sync::Arc<std::sync::Mutex<String>>,
}

/// How long to wait for the CLI to show the URL. Machine time: a container start and an HTTP call.
const PATIENCE_FOR_THE_LINK: Duration = Duration::from_secs(90);

/// How long to wait once a code has been sent. Also machine time, but through Anthropic.
const PATIENCE_FOR_THE_TOKEN: Duration = Duration::from_secs(120);

/// How long a person is given to approve in their browser.
///
/// Generous on purpose: this covers finding a password, a second factor, and possibly choosing
/// between accounts. The failure of being too short is telling somebody who did nothing wrong that
/// it did not work, and making them start again.
const PATIENCE_FOR_THE_PERSON: Duration = Duration::from_secs(600);

impl SigningIn {
    /**
    Start the flow and return the URL a browser has to open.

    In a throwaway container from the harness image, because this runs on the model screen, before
    any stack is up, and because the image is where the bundled CLI lives. Nothing is installed on
    the person's machine and nothing is left behind: `--rm`, no ports, no mounts, no name.

    Under a pty because the CLI draws a terminal. Given plain pipes it writes nothing at all and
    waits — measured, not assumed: the same command produced zero bytes on a pipe and 4 kB on a pty.
    */
    pub fn begin(engine: &crate::engine::Address, image: &str) -> Result<(Self, String), String> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 48,
                // Wide on purpose. The CLI wraps the consent URL to the terminal's width, and while
                // the intact copy is read from the hyperlink rather than the wrapped text, a narrow
                // terminal also wraps the prompt this has to recognise.
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("A terminal could not be opened for the sign-in: {e}"))?;

        // Through `Address::parts`, so a Podman machine addressed by name here is addressed by
        // name exactly as it is everywhere else. A sign-in run against the default connection on a
        // machine that has two is the "Cannot connect to Podman" class of failure all over again.
        let (binary, arguments) = engine.parts();
        let mut command = CommandBuilder::new(binary);
        for argument in arguments {
            command.arg(argument);
        }
        command.arg("run");
        command.arg("--rm");
        command.arg("-i");
        command.arg("-t");
        command.arg(image);
        command.arg(BUNDLED_CLI);
        command.arg("setup-token");

        let child = pty
            .slave
            .spawn_command(command)
            .map_err(|e| format!("The sign-in did not start: {e}"))?;
        // Held by the child now. Dropping ours is what makes a read see EOF when it exits, rather
        // than blocking on a handle nobody will ever write to.
        drop(pty.slave);

        let writer = pty
            .master
            .take_writer()
            .map_err(|e| format!("The sign-in could not be typed into: {e}"))?;
        let mut reader = pty
            .master
            .try_clone_reader()
            .map_err(|e| format!("The sign-in could not be read: {e}"))?;

        /*
         * Read on its own thread and accumulate.
         *
         * A pty read blocks, and everything this needs appears before the command exits: the URL
         * first, the token later. Waiting for exit would mean waiting out the whole flow before
         * showing anybody the URL they have to open.
         */
        let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let filling = std::sync::Arc::clone(&output);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let Ok(mut held) = filling.lock() else { break };
                held.push_str(&String::from_utf8_lossy(&buffer[..read]));
            }
        });

        let mut signing = Self {
            child,
            writer,
            output,
        };
        let url = signing
            .wait_for(authorize_url_in, PATIENCE_FOR_THE_LINK)
            .ok_or_else(|| signing.gave_up("The sign-in never offered a link to open."))?;
        Ok((signing, url))
    }

    /// Hand back the code from the browser and wait for the token.
    pub fn finish(mut self, code: &str) -> Result<String, String> {
        if self
            .wait_for(
                |seen| wants_the_code(seen).then_some(()),
                PATIENCE_FOR_THE_PERSON,
            )
            .is_none()
        {
            return Err(self.gave_up("The sign-in stopped before it asked for the code."));
        }
        /*
         * `\r`, NOT `\n`, and this is the difference between working and silently not.
         *
         * Enter on a terminal is a carriage return, and a TUI reading a pty in raw mode takes that
         * and not a line feed. Sent `\n` the code appears in the prompt, masked, and is never
         * submitted: the flow then times out and reports the code was refused, when nothing had
         * looked at it. Found by dumping the transcript, which ended with the prompt and exactly as
         * many asterisks as the code had characters.
         *
         * Trimmed, because a code arrives pasted and a trailing newline or space is the person's
         * clipboard rather than their intent.
         */
        write!(self.writer, "{}", code.trim())
            .map_err(|e| format!("The code could not be sent to the sign-in: {e}"))?;
        self.writer
            .flush()
            .map_err(|e| format!("The code could not be sent to the sign-in: {e}"))?;

        /*
         * Enter goes separately, after a pause, and both details are load-bearing.
         *
         * `\r` rather than `\n` because Enter on a terminal is a carriage return and a TUI reading a
         * pty in raw mode takes that. And on its own rather than appended, because the CLI turns on
         * bracketed paste and a code arrives as one burst: a 32-character code with the return in
         * the same write submitted fine, and a 92-character one did not — it sat in the prompt,
         * masked, until the wait expired, and was then reported as refused when nothing had read it.
         * Two writes with a gap makes the return a keypress after the input has settled rather than
         * the tail of a paste.
         */
        std::thread::sleep(Duration::from_millis(250));
        write!(self.writer, "\r")
            .map_err(|e| format!("The code could not be sent to the sign-in: {e}"))?;
        self.writer
            .flush()
            .map_err(|e| format!("The code could not be sent to the sign-in: {e}"))?;

        // Either answer ends the wait. Watching only for the token means a refused code costs the
        // whole timeout and is then reported as though nothing had happened.
        enum Outcome {
            Token(String),
            Refused,
        }
        let outcome = self.wait_for(
            |seen| {
                token_in(seen)
                    .map(Outcome::Token)
                    .or_else(|| refused_the_code(seen).then_some(Outcome::Refused))
            },
            PATIENCE_FOR_THE_TOKEN,
        );

        match outcome {
            Some(Outcome::Token(token)) => {
                self.stop();
                Ok(token)
            }
            Some(Outcome::Refused) => Err(self.gave_up(
                "That code was refused. A code can only be used once and does not last long, so start the sign-in again and bring back a fresh one.",
            )),
            None => Err(self.gave_up(
                "That sign-in did not finish. Start it again and approve the request in your browser.",
            )),
        }
    }

    /// Poll the accumulated output until `found` finds something, the command exits, or patience
    /// runs out.
    fn wait_for<T>(&mut self, found: impl Fn(&str) -> Option<T>, patience: Duration) -> Option<T> {
        let began = Instant::now();
        while began.elapsed() < patience {
            if let Ok(seen) = self.output.lock() {
                if let Some(value) = found(&seen) {
                    return Some(value);
                }
            }
            // A finished command with nothing found is a refusal, not something still to wait for.
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                // One more look: the last write and the exit race, and the token is written first.
                std::thread::sleep(Duration::from_millis(150));
                return self.output.lock().ok().and_then(|seen| found(&seen));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        None
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /**
    Stop, and say what to do about it.

    THE OUTPUT IS NEVER PUT IN THE MESSAGE. It is a terminal's worth of escapes at best, and at
    worst it holds the token in a shape the scan did not match, which would then be handed to the
    window and drawn on a screen. Whatever went wrong, the person gets a sentence they can act on.
    */
    fn gave_up(&mut self, saying: &str) -> String {
        /*
         * A way to see what the terminal actually said, for diagnosing this by hand.
         *
         * Off unless `OPENBOT_SIGNIN_TRANSCRIPT` names a file, because the transcript can contain
         * the token: a sign-in that printed one in a shape the scan did not match is exactly the
         * case worth looking at, and exactly the case where the file holds a live credential. Never
         * on in a build somebody installs, and never in the message handed to the window.
         */
        if let Ok(path) = std::env::var("OPENBOT_SIGNIN_TRANSCRIPT") {
            if let Ok(seen) = self.output.lock() {
                let _ = std::fs::write(path, seen.as_str());
            }
        }
        self.stop();
        saying.to_string()
    }
}

/// The image whose `langchain-openai` runs the ChatGPT sign-in.
///
/// The LangGraph harness, used as a tool rather than as a Bot for the same reason the Claude one is:
/// it is the image that already carries the vendor's own login. It is also the default harness, so
/// on the common path this image is being pulled anyway.
pub const CHATGPT_SIGN_IN_IMAGE: &str = "openbot-agent-langgraph-agui:v0.0.8";

/// Where the vendor's login persists what it gets.
const CHATGPT_STORE: &str = "/root/.langchain/chatgpt-auth.json";

/// The port the vendor's login binds, and the port the container publishes to reach it.
///
/// Two different numbers on purpose. See `CHATGPT_LOGIN`.
const CHATGPT_LOOPBACK: u16 = 1455;
const CHATGPT_RELAY: u16 = 1456;

/**
The ChatGPT sign-in, as a program handed to the harness image.

WHY THERE IS A RELAY IN HERE. `langchain-openai` refuses a non-loopback callback host on purpose:
RFC 8252 wants a loopback redirect for a native app, and binding `0.0.0.0` would put the
authorization code on the local network. But a published Docker port cannot reach a `127.0.0.1`
listener inside the container. So the vendor's server keeps its loopback bind and this relay accepts
on `0.0.0.0:1456` and forwards into it. The container publishes 1456 as the host's 1455, which is
the address the browser is sent to.

AND THE HOST IS LEFT AT ITS DEFAULT, `localhost`, WHICH IS NOT COSMETIC. OpenAI compares the
redirect URI as a string, and `http://localhost:1455/auth/callback` is what is registered. Passing
`127.0.0.1` — the same address, a different string — makes the authorize request fail with
`unknown_error` before any login page is drawn. Measured, twice, before the cause was obvious.

Passed as an argument rather than a mounted file, so the app never has to write a script to disk to
run one.
*/
const CHATGPT_LOGIN: &str = r#"
import json, socket, threading
from pathlib import Path

def pump(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

def relay():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", RELAY))
    listener.listen(8)
    while True:
        client, _ = listener.accept()
        try:
            upstream = socket.create_connection(("127.0.0.1", LOOPBACK), timeout=10)
        except OSError:
            client.close()
            continue
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pump, args=(upstream, client), daemon=True).start()

threading.Thread(target=relay, daemon=True).start()

from langchain_openai.chatgpt_oauth import login_chatgpt

login_chatgpt(open_browser=False, port=LOOPBACK, timeout=900)

raw = json.loads(Path(STORE).read_text())
print("OPENBOT_CHATGPT_TOKEN=" + (raw.get("access_token") or raw.get("token") or ""), flush=True)
"#;

/// The token the vendor's login printed, if it got one.
///
/// Its own line rather than scraped out of the store file, because the store shape belongs to the
/// library and the line is this deployment's own contract with the program above.
pub fn chatgpt_token_in(output: &str) -> Option<String> {
    plain(output)
        .lines()
        .filter_map(|line| line.trim().strip_prefix("OPENBOT_CHATGPT_TOKEN="))
        .map(str::trim)
        .find(|token| !token.is_empty())
        .map(str::to_string)
}

/// The address a browser has to open for the ChatGPT sign-in.
///
/// Printed by the vendor's login as its fallback when `open_browser` is off, which is how this gets
/// it: OpenBot opens the browser itself so the window can also show the link.
pub fn openai_url_in(output: &str) -> Option<String> {
    plain(output)
        .split_whitespace()
        .find(|word| word.starts_with("https://auth.openai.com/oauth/authorize"))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixtures are composed from the prefix rather than written out, so no credential-shaped
    /// literal sits in this repository for a scanner to find or a person to copy.
    fn plan_token() -> String {
        format!("{PLAN_TOKEN_PREFIX}01-{}", "AbCdEf0123456789".repeat(3))
    }

    fn api_key() -> String {
        format!(
            "{}03-{}",
            concat!("sk", "-ant-api"),
            "AbCdEf0123456789".repeat(3)
        )
    }

    /// The URL comes from the hyperlink, not the wrapped text beside it.
    ///
    /// This is the real shape: the CLI emits an OSC-8 link whose target is intact, then draws the
    /// same URL as display text with line breaks spliced into the query string. Taking the visible
    /// copy gives a URL that opens and then fails on a mangled `state`.
    #[test]
    fn the_intact_url_is_taken_and_not_the_wrapped_one() {
        let real =
            "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=intact-state";
        let output = format!(
            "Browser didn't open? Use the url below to sign in\r\n\
             \u{1b}]8;id=1az7qzj;{real}\u{1b}\\\
             https://claude.com/cai/oauth/authorize?code=true&client_id=abc&sta\r\nte=BROKEN\
             \u{1b}]8;;\u{1b}\\\r\n"
        );
        assert_eq!(authorize_url_in(&output).as_deref(), Some(real));
    }

    #[test]
    fn no_url_before_the_cli_has_printed_one() {
        assert_eq!(authorize_url_in("Welcome to Claude Code\r\n"), None);
    }

    /// The prompt is recognised in the shape the CLI actually writes it.
    ///
    /// Which is not with spaces: it moves the cursor between words. The earlier version of this
    /// test used a fixture with real spaces, passed, and hid a bug that cost a live sign-in.
    #[test]
    fn the_code_prompt_is_seen_when_the_words_are_cursor_positioned() {
        let real = "\u{1b}[2G\u{1b}[38;2;255;255;255mPaste\u{1b}[8Gcode\u{1b}[13Ghere\u{1b}[18Gif\u{1b}[21Gprompted\u{1b}[30G>";
        assert!(wants_the_code(real), "the real prompt shape was not seen");
        // And still when a terminal does use spaces.
        assert!(wants_the_code("Paste code here if prompted >"));
        assert!(!wants_the_code("Opening browser to sign in…"));
    }

    /// The refusal, in the shape the CLI writes it. Taken from a real run with a bad code.
    #[test]
    fn a_refused_code_is_recognised() {
        let real = "Paste\u{1b}[8Gcode\u{1b}[13Ghere> ****\r\n\u{1b}[2GOAuth\u{1b}[8Gerror:\u{1b}[15GRequest\u{1b}[23Gfailed\u{1b}[30Gwith\u{1b}[35Gstatus\u{1b}[42Gcode\u{1b}[47G400\r\nPress\u{1b}[7GEnter\u{1b}[13Gto\u{1b}[16Gretry.";
        assert!(refused_the_code(real), "the real refusal was not seen");
        assert!(!refused_the_code("Paste code here if prompted >"));
    }

    #[test]
    fn the_token_is_found_in_real_output() {
        let token = plan_token();
        let output = format!(
            "\u{1b}[?25l\u{1b}[1mLogin successful\u{1b}[0m\r\n\r\n\
             Set this as CLAUDE_CODE_OAUTH_TOKEN:\r\n\r\n  {token}\r\n\r\n"
        );
        assert_eq!(token_in(&output).as_deref(), Some(token.as_str()));
    }

    #[test]
    fn a_quoted_token_is_found_without_its_quotes() {
        let token = plan_token();
        let output = format!("export CLAUDE_CODE_OAUTH_TOKEN=\"{token}\"");
        assert_eq!(token_in(&output).as_deref(), Some(token.as_str()));
    }

    /// The must-not case. An API key is not a plan token, and accepting one here would write the
    /// exact credential the plan path exists to avoid: it outranks the token, so the person who
    /// just signed in to a plan would be billed per request instead.
    #[test]
    fn an_api_key_is_not_mistaken_for_a_plan_token() {
        let output = format!("your key is {}", api_key());
        assert_eq!(token_in(&output), None);
    }

    /// Instructions that merely name the variable are not a token.
    #[test]
    fn the_instructions_alone_yield_nothing() {
        assert_eq!(
            token_in("Set CLAUDE_CODE_OAUTH_TOKEN to the token this prints."),
            None
        );
    }

    /// Token-shaped but far too short is a half-read buffer, not a credential.
    #[test]
    fn a_truncated_token_is_refused() {
        assert_eq!(token_in(&format!("{PLAN_TOKEN_PREFIX}01-abc")), None);
    }

    /// The token line is this deployment's contract with the program it hands the image.
    #[test]
    fn the_chatgpt_token_is_read_off_its_own_line() {
        let output = "some chatter\nOPENBOT_CHATGPT_TOKEN=abc123\nmore chatter\n";
        assert_eq!(chatgpt_token_in(output).as_deref(), Some("abc123"));
        // An empty value is not a token: the store had no access token in it.
        assert_eq!(chatgpt_token_in("OPENBOT_CHATGPT_TOKEN=\n"), None);
        assert_eq!(chatgpt_token_in("nothing here"), None);
    }

    /// The URL the vendor's login prints as its fallback.
    #[test]
    fn the_openai_url_is_found() {
        let real = "https://auth.openai.com/oauth/authorize?client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
        assert_eq!(
            openai_url_in(&format!("Open this: {real}\n")).as_deref(),
            Some(real)
        );
        assert_eq!(openai_url_in("no url yet"), None);
    }

    /// The registered redirect is `localhost`, and the script must not name anything else.
    ///
    /// `127.0.0.1` is the same address and a different string, and OAuth registration compares
    /// strings: passing it makes the authorize request fail with `unknown_error` before a login
    /// page is ever drawn. That cost two live attempts.
    #[test]
    fn the_login_leaves_the_callback_host_alone() {
        assert!(
            !CHATGPT_LOGIN.contains("host="),
            "the script names a callback host; the default `localhost` is what OpenAI registered"
        );
    }

    #[test]
    fn nothing_in_nothing() {
        assert_eq!(token_in(""), None);
        assert_eq!(authorize_url_in(""), None);
    }

    /// The stripper has to survive what a TUI actually emits, including a bare ESC pair.
    #[test]
    fn escapes_come_out_and_the_words_stay() {
        assert_eq!(plain("\u{1b}[1mbold\u{1b}[0m plain"), "bold plain");
        assert_eq!(plain("\u{1b}]0;title\u{7}after"), "after");
        assert_eq!(plain("\u{1b}(Bkept"), "kept");
    }
}

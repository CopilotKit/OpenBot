//! The images the two plans run on, and where a ChatGPT plan's engine is.
//!
//! Both plans sign in natively, with nothing in a container: a Claude plan in `claude_sign_in`,
//! a ChatGPT plan in `chatgpt_sign_in` (OpenAI's Sign in with ChatGPT plan usage). The browser comes
//! back to a loopback listener of Desktop's own, and nothing is pasted.

/**
The published name of the Claude Agent SDK harness image: the Bot a Claude plan runs on.

Named for the sign-in it once ran, which no longer needs it: the Claude plan's sign-in is native
(`claude_sign_in`). Install pulls it only for an installation on a Claude plan
(`preparation::PLAN_IMAGES`), and Start pulls it when a plan picks it.

A NAME, NOT A REFERENCE. This was `openbot-harness-claude-sdk:test`, which is what a development
tree builds: it resolved locally on the machine it was written on and, on a machine that had never
built anything, sent Podman to `docker.io/library/openbot-harness-claude-sdk`. Resolved through the
release's manifest by `crate::deployment::reference`, like every other image.
*/
pub const SIGN_IN_IMAGE: &str = "agent-claude-sdk";

/// The published name of a ChatGPT plan's engine: OpenAI's own Agents SDK, served over AG-UI, on
/// the plan's Sign in with ChatGPT token (`agent-openai-agents/`).
///
/// The sign-in itself no longer runs in an image: Desktop runs it natively (`chatgpt_sign_in`).
/// Kept under this name because Install, the release's image list and Start all reach the plan's
/// engine image through it.
///
/// A name, not a reference: see `SIGN_IN_IMAGE`.
pub const CHATGPT_SIGN_IN_IMAGE: &str = "agent-openai-agents";

/// The Compose service that runs a signed-in ChatGPT plan's engine.
///
/// The OpenAI Agents SDK engine, which is the plan's Bot (`harness::speaking_for("openai")`) and,
/// at the same address, the plan's model for the server's own Bots on that plan. A service of its
/// own behind its own profile, started only on a ChatGPT plan, at Start or alone when the plan is
/// chosen in the app (`crate::ai_connection::Plan`).
pub const CHATGPT_PLAN_SERVICE: &str = "agent-chatgpt-plan";

/// Where the server reaches that service: its name on the Compose network and the port its
/// Dockerfile fixes. Written to `.env` as `CHATGPT_PLAN_HARNESS_URL` on every Start, so a plan
/// chosen in the app reaches it with no restart.
pub const CHATGPT_PLAN_URL: &str = "http://agent-chatgpt-plan:4216";

/**
Let a redirect OpenBot's page asks Desktop to catch (`sign_in_redirect`) have port 1455.

Refused while Desktop's own ChatGPT plan sign-in is waiting there: a person is approving it. Its
listener prefers 1455 and takes another port when 1455 is held, so a sign-in elsewhere is no
obstacle.
*/
pub(crate) fn make_way_for_sign_in_redirect() -> Result<(), ()> {
    if crate::chatgpt_sign_in::waiting_on(crate::sign_in_redirect::OPENAI_PORT) {
        Err(())
    } else {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    /// Port 1455 is one port on the whole machine: the tests that bind it take turns.
    pub(crate) static CALLBACK_PORT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A redirect the page asked Desktop to catch waits while Desktop's own ChatGPT sign-in holds
    /// 1455, and has it once that sign-in ends.
    #[test]
    fn a_page_redirect_waits_for_desktops_own_chatgpt_sign_in_on_1455() {
        let _port = CALLBACK_PORT
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let _ports = crate::test_support::hold_ports();
        let root = crate::test_support::temp_root("chatgpt-sign-in-holds-1455");
        let endpoints = crate::chatgpt_sign_in::Endpoints {
            authorize: "https://auth.example.test/api/accounts/authorize".into(),
            token: "http://127.0.0.1:9/token".into(),
            jwks: "http://127.0.0.1:9/jwks".into(),
            issuer: "https://auth.example.test".into(),
        };
        let url = crate::chatgpt_sign_in::begin_with(&endpoints, &root).unwrap();
        let on_1455 = url.contains("127.0.0.1%3A1455");
        assert_eq!(super::make_way_for_sign_in_redirect().is_err(), on_1455);
        crate::chatgpt_sign_in::cancel();
        assert!(super::make_way_for_sign_in_redirect().is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}

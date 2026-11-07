//! The parts of the shell that are worth testing without a window around them.
pub mod acquire;
pub mod app_update;
pub mod cli_release;
pub mod composio;
pub mod deployment;
pub mod deployment_release;
pub mod docker_config;
pub mod docker_desktop;
pub mod engine;
pub mod env;
pub mod harness;
pub mod host_access;
pub mod install;
pub mod local_eval;
pub mod local_eval_state;
pub mod plan;
pub mod preparation;
pub mod problem;
pub mod provider;
pub mod provider_oauth;
pub mod pull_metrics;
pub mod quiet;
pub mod recorder_external;
pub mod recorder_host;
pub mod recorder_install;
pub mod saved_intent;
pub mod shell_updates;
pub mod speech;
pub mod stack;
pub mod telemetry;
pub mod tray;
pub mod upgrade;
pub mod vault;
pub mod windows;

#[cfg(test)]
pub(crate) mod test_support;

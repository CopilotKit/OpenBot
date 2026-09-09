//! The parts of the shell that are worth testing without a window around them.
pub mod acquire;
pub mod ask;
pub mod deployment;
pub mod engine;
pub mod env;
pub mod harness;
pub mod install;
pub mod intelligence;
pub mod plan;
pub mod problem;
pub mod provider;
pub mod quiet;
pub mod saved_intent;
pub mod stack;
pub mod supervise;
pub mod tray;
pub mod vault;
pub mod windows;

#[cfg(test)]
pub(crate) mod test_support;

pub mod recovery;

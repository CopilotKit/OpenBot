//! Exercise the production emitter against an explicit local receiver, without starting OpenBot.
use openbot_desktop_lib::telemetry::{
    Architecture, Config, Context, Distribution, Engine, EventData, NumericVersion, Platform,
    RuntimeEnv, Step, Telemetry,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: telemetry_probe DATA_DIR http://127.0.0.1:PORT/ingest record|flush|quit|activate|env".into());
    }
    let url = reqwest::Url::parse(&args[2])?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("this validation probe only sends to a local HTTP receiver".into());
    }
    let telemetry = Telemetry::open(
        &args[1],
        Context {
            distribution: Distribution::Desktop,
            app_version: NumericVersion::parse("0.0.9")?,
            platform: if cfg!(target_os = "windows") {
                Platform::Windows
            } else if cfg!(target_os = "macos") {
                Platform::Macos
            } else {
                Platform::Linux
            },
            arch: if cfg!(target_arch = "aarch64") {
                Architecture::Aarch64
            } else {
                Architecture::X86_64
            },
            os_version: None,
            engine: Engine::Docker,
            runtime_env: RuntimeEnv::Test,
        },
        Config {
            enabled: true,
            endpoint: Some(args[2].clone()),
            max_queue: 256,
        },
    )?;
    match args[3].as_str() {
        "record" => {
            telemetry.record(EventData::StepViewed { step: Step::Model })?;
            // Intentionally leave the process without shutdown to exercise restart recovery.
        }
        "flush" => telemetry.flush()?,
        "quit" => {
            telemetry.record(EventData::StepViewed {
                step: Step::Harness,
            })?;
            telemetry.shutdown()?;
        }
        "activate" => {
            telemetry.record(EventData::Activated)?;
            telemetry.record(EventData::Activated)?;
            telemetry.shutdown()?;
        }
        "env" => {}
        _ => return Err("unknown probe action".into()),
    }
    println!("{}", serde_json::to_string(&telemetry.runtime_env())?);
    Ok(())
}

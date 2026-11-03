# Needle on the phone

[Needle](https://github.com/cactus-compute/needle) by Cactus Compute (Apache-2.0) is a tiny model
that turns a request into actions. OpenBot's phone app uses it for the Phone Bot, which works with no
PC and no signal. Usage counts are switched off (`NEEDLE_TELEMETRY=0`, `DO_NOT_TRACK=1`).

Two files from Needle's Hugging Face page go in before building the app:

| File | From | Goes to |
| --- | --- | --- |
| `libneedle.a` | `Cactus-Compute/needle3`, folder `android-arm64` | `modules/needle/android/libs/arm64-v8a/` |
| `needle3.cact` | `Cactus-Compute/needle3` | `modules/needle/assets/` |

`npm run get-needle` (in `mobile/`) downloads both. Without them the app still builds and the Phone
Bot screen says Needle is missing. Neither file is kept in git.

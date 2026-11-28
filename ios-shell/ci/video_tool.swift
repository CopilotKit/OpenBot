// FOR CI ONLY. Cuts a recording and, optionally, scales it to a width, with AVFoundation (no
// ffmpeg needed on the runner).
//
//   swift ios-shell/ci/video_tool.swift <in.mp4> <out.mp4> <start seconds> <length seconds, 0 = to the end> <width, 0 = keep>
import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count == 6, let start = Double(args[3]), let length = Double(args[4]), let width = Double(args[5]) else {
    FileHandle.standardError.write("usage: video_tool.swift in out start length width\n".data(using: .utf8)!)
    exit(2)
}
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let output = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: output)
// Cutting alone copies the stream (no re-encode); scaling needs one encode.
let preset = width > 0 ? AVAssetExportPresetMediumQuality : AVAssetExportPresetPassthrough
guard let export = AVAssetExportSession(asset: asset, presetName: preset) else {
    FileHandle.standardError.write("no export session\n".data(using: .utf8)!)
    exit(1)
}
export.outputURL = output
export.outputFileType = .mp4
let total = asset.duration
let from = CMTime(seconds: start, preferredTimescale: 600)
let span = length > 0 ? CMTime(seconds: length, preferredTimescale: 600) : CMTimeSubtract(total, from)
export.timeRange = CMTimeRange(start: from, duration: span)
if width > 0, let track = asset.tracks(withMediaType: .video).first {
    let natural = track.naturalSize.applying(track.preferredTransform)
    let size = CGSize(width: abs(natural.width), height: abs(natural.height))
    let scale = width / size.width
    var height = (size.height * scale).rounded()
    if Int(height) % 2 == 1 { height += 1 }
    let composition = AVMutableVideoComposition()
    composition.renderSize = CGSize(width: width, height: height)
    composition.frameDuration = CMTime(value: 1, timescale: 30)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: total)
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
    layer.setTransform(track.preferredTransform.concatenating(CGAffineTransform(scaleX: scale, y: scale)), at: .zero)
    instruction.layerInstructions = [layer]
    composition.instructions = [instruction]
    export.videoComposition = composition
}
let done = DispatchSemaphore(value: 0)
export.exportAsynchronously { done.signal() }
done.wait()
if export.status != .completed {
    FileHandle.standardError.write("export failed: \(String(describing: export.error))\n".data(using: .utf8)!)
    exit(1)
}

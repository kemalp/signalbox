#!/usr/bin/env swift
// Draws the Signalbox app icon with Core Graphics: a railway semaphore signal (a teal arm raised to "clear", an
// amber lamp at its pivot) on a slate rounded square, in the macOS icon grid (an 824 pt body on a 1024 canvas).
// Provider-neutral on purpose: no vendor marks or look-alikes.
//
//   swift apps/macos/scripts/make-icon.swift                    # writes Resources/AppIcon.iconset, Resources/AppIcon.icns and
//                                                                 # Resources/AppIcon.icon (the Icon Composer form macOS 26 renders)
//   swift apps/macos/scripts/make-icon.swift --preview <dir>    # also writes preview PNGs (1024, 32, 16, magnified, contact sheet)
//
// AppIcon.icon holds the same drawing as a slate fill and two layers (the ground line, and the signal), edge
// to edge on a 1024 canvas: macOS 26 applies the rounded-square mask, the shadow and the glass itself. build-app.sh compiles it with
// actool into Assets.car (CFBundleIconName) and keeps AppIcon.icns as the fallback (CFBundleIconFile).
//
// Sizes of 32 px and below use a simplified drawing (thicker post and arm, a bigger lamp, no stripe or glow) so the
// signal still reads in Finder lists and the menu bar's app switcher.
import AppKit
import SwiftUI

let scriptDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let macosDir = scriptDir.deletingLastPathComponent()
let resources = macosDir.appendingPathComponent("Resources")
let iconset = resources.appendingPathComponent("AppIcon.iconset")
let icns = resources.appendingPathComponent("AppIcon.icns")
let iconComposer = resources.appendingPathComponent("AppIcon.icon")

var previewDir: URL?
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    switch a {
    case "--preview":
        guard let dir = args.next() else { fatalError("--preview needs a directory") }
        previewDir = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
    default:
        FileHandle.standardError.write(Data("make-icon: unknown argument \(a)\n".utf8))
        exit(2)
    }
}

// MARK: - Palette

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

let slateTop = rgb(0x3E5366)
let slateBottom = rgb(0x18232D)
let postLight = rgb(0xE3E9EE)
let postDark = rgb(0xA3B1BD)
let tealLight = rgb(0x48DECB)
let tealDark = rgb(0x0E9384)
let stripe = rgb(0xF5F8FA)
let housing = rgb(0x0B1218)
let amberCore = rgb(0xFFE08A)
let amberEdge = rgb(0xF59E0B)

// MARK: - Drawing (in a 1024 × 1024 space, origin top left)

func linear(_ ctx: CGContext, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
    ctx.drawLinearGradient(g, start: from, end: to, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
}

func radial(_ ctx: CGContext, _ colors: [CGColor], center: CGPoint, radius: CGFloat, extend: Bool = false) {
    let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: nil)!
    ctx.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: extend ? [.drawsAfterEndLocation] : [])
}

func continuousRect(_ rect: CGRect, radius: CGFloat) -> CGPath {
    RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect).cgPath
}

/// `small`: the simplified drawing for 32 px and below. `scale`: pixels per unit; Core Graphics shadows are in
/// pixels, not in the transformed space, so their offset and blur are scaled by hand.
func drawIcon(_ ctx: CGContext, small: Bool, scale: CGFloat) {
    func shadow(y: CGFloat, blur: CGFloat, alpha: CGFloat) {
        // The context's y axis is flipped, so a downward shadow has a negative device offset.
        ctx.setShadow(offset: CGSize(width: 0, height: -y * scale), blur: blur * scale, color: rgb(0x000000, alpha))
    }
    let body = CGRect(x: 100, y: 100, width: 824, height: 824)
    let bodyPath = continuousRect(body, radius: 185.4)

    // Soft drop shadow under the body (inside the canvas, as the system grid expects).
    ctx.saveGState()
    shadow(y: 10, blur: 24, alpha: 0.35)
    ctx.addPath(bodyPath)
    ctx.setFillColor(slateBottom)
    ctx.fillPath()
    ctx.restoreGState()

    // Body: slate, lighter at the top, with a faint glow behind the lamp.
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    drawBackground(ctx, small: small)
    drawSignal(ctx, small: small, scale: scale)

    // A hairline inner edge: light at the top, for the rounded-square depth macOS icons have.
    ctx.restoreGState()
    ctx.saveGState()
    ctx.addPath(continuousRect(body.insetBy(dx: 1.5, dy: 1.5), radius: 184))
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    linear(ctx, [rgb(0xFFFFFF, 0.30), rgb(0xFFFFFF, 0.02)], from: CGPoint(x: 0, y: 100), to: CGPoint(x: 0, y: 520))
    ctx.restoreGState()
}

/// The slate body's fill (in the 1024 space, body at 100…924): gradient, glow and the ground line.
func drawBackground(_ ctx: CGContext, small: Bool) {
    linear(ctx, [slateTop, slateBottom], from: CGPoint(x: 0, y: 100), to: CGPoint(x: 0, y: 924))
    drawBackgroundDetails(ctx, small: small)
}

/// The glow and the ground line, on nothing. The Icon Composer form leaves the glow out: the system draws its own
/// light on the glass, and a soft glow makes a big, poorly compressing layer.
func drawBackgroundDetails(_ ctx: CGContext, small: Bool, glow: Bool = true) {
    if glow {
        radial(ctx, [rgb(0x5B7A90, 0.55), rgb(0x5B7A90, 0)], center: CGPoint(x: 300, y: 230), radius: 520)
    }

    // Ground: a low rail line across the bottom.
    if !small {
        ctx.setFillColor(rgb(0x0F1820, 0.55))
        ctx.fill(CGRect(x: 100, y: 838, width: 824, height: 86))
        ctx.setFillColor(rgb(0x8FA0AE, 0.35))
        ctx.fill(CGRect(x: 100, y: 836, width: 824, height: 6))
    }
}

/// The signal itself: post, arm and lamp, on nothing.
func drawSignal(_ ctx: CGContext, small: Bool, scale: CGFloat) {
    func shadow(y: CGFloat, blur: CGFloat, alpha: CGFloat) {
        ctx.setShadow(offset: CGSize(width: 0, height: -y * scale), blur: blur * scale, color: rgb(0x000000, alpha))
    }
    let pivot = CGPoint(x: 378, y: 478)
    let angle = -32.0 * .pi / 180

    // Post.
    let postWidth: CGFloat = small ? 112 : 62
    let postTop = pivot.y - (small ? 40 : 96)
    // Big: the post ends under the foot. Small: it runs off the bottom edge.
    let post = CGRect(x: pivot.x - postWidth / 2, y: postTop, width: postWidth, height: (small ? 880 : 846) - postTop)
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: post, cornerWidth: postWidth / 2, cornerHeight: postWidth / 2, transform: nil))
    ctx.clip()
    linear(ctx, [postLight, postDark], from: CGPoint(x: post.minX, y: 0), to: CGPoint(x: post.maxX, y: 0))
    ctx.restoreGState()
    if !small {
        // Finial and a ladder-like pair of rungs: details that only show when big.
        ctx.setFillColor(postLight)
        ctx.fillEllipse(in: CGRect(x: pivot.x - 30, y: postTop - 44, width: 60, height: 60))
        ctx.setFillColor(rgb(0x7E8E9C))
        for y in stride(from: CGFloat(600), through: 780, by: 60) {
            ctx.fill(CGRect(x: pivot.x - postWidth / 2, y: y, width: postWidth, height: 7))
        }
        // Foot.
        ctx.addPath(CGPath(roundedRect: CGRect(x: pivot.x - 92, y: 822, width: 184, height: 34), cornerWidth: 10, cornerHeight: 10, transform: nil))
        ctx.setFillColor(rgb(0x8C9BA8))
        ctx.fillPath()
    }

    // Arm: a blade raised to "clear", teal with a light band near its end.
    let armLength: CGFloat = small ? 470 : 448
    let armHeight: CGFloat = small ? 168 : 104
    ctx.saveGState()
    ctx.translateBy(x: pivot.x, y: pivot.y)
    ctx.rotate(by: angle)
    let arm = CGRect(x: 0, y: -armHeight / 2, width: armLength, height: armHeight)
    ctx.saveGState()
    if !small { shadow(y: 8, blur: 18, alpha: 0.35) }
    ctx.addPath(CGPath(roundedRect: arm, cornerWidth: small ? 24 : 16, cornerHeight: small ? 24 : 16, transform: nil))
    ctx.setFillColor(tealDark)
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(CGPath(roundedRect: arm, cornerWidth: small ? 24 : 16, cornerHeight: small ? 24 : 16, transform: nil))
    ctx.clip()
    linear(ctx, [tealLight, tealDark], from: CGPoint(x: 0, y: -armHeight / 2), to: CGPoint(x: 0, y: armHeight / 2))
    if !small {
        ctx.setFillColor(stripe)
        ctx.fill(CGRect(x: armLength - 118, y: -armHeight / 2, width: 46, height: armHeight))
        // A thin highlight along the top edge for depth.
        ctx.setFillColor(rgb(0xFFFFFF, 0.28))
        ctx.fill(CGRect(x: 0, y: -armHeight / 2, width: armLength, height: 6))
    }
    ctx.restoreGState()

    // Lamp at the pivot: a dark housing with an amber lens.
    let housingR: CGFloat = small ? 118 : 92
    let lensR: CGFloat = small ? 82 : 58
    if !small {
        radial(ctx, [rgb(0xFFB020, 0.45), rgb(0xFFB020, 0)], center: pivot, radius: 220)
    }
    ctx.setFillColor(housing)
    ctx.fillEllipse(in: CGRect(x: pivot.x - housingR, y: pivot.y - housingR, width: housingR * 2, height: housingR * 2))
    if !small {
        ctx.setStrokeColor(rgb(0x9AAAB7, 0.7))
        ctx.setLineWidth(5)
        ctx.strokeEllipse(in: CGRect(x: pivot.x - housingR + 2.5, y: pivot.y - housingR + 2.5, width: housingR * 2 - 5, height: housingR * 2 - 5))
    }
    ctx.saveGState()
    ctx.addEllipse(in: CGRect(x: pivot.x - lensR, y: pivot.y - lensR, width: lensR * 2, height: lensR * 2))
    ctx.clip()
    radial(ctx, [amberCore, amberEdge], center: CGPoint(x: pivot.x - lensR * 0.25, y: pivot.y - lensR * 0.3), radius: lensR * 1.2, extend: true)
    ctx.restoreGState()
    if !small {
        ctx.setFillColor(rgb(0xFFFFFF, 0.75))
        ctx.fillEllipse(in: CGRect(x: pivot.x - lensR * 0.55, y: pivot.y - lensR * 0.62, width: lensR * 0.42, height: lensR * 0.3))
    }
}

func render(px: Int) -> CGImage {
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.setShouldAntialias(true)
    // Top-left origin, 1024 units across.
    ctx.translateBy(x: 0, y: CGFloat(px))
    ctx.scaleBy(x: CGFloat(px) / 1024, y: -CGFloat(px) / 1024)
    drawIcon(ctx, small: px <= 32, scale: CGFloat(px) / 1024)
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
}

// MARK: - Iconset and icns

let fm = FileManager.default
try? fm.removeItem(at: iconset)
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
        writePNG(render(px: points * scale), to: iconset.appendingPathComponent(name))
    }
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", icns.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed with status \(iconutil.terminationStatus)") }
print(icns.path)

// MARK: - Icon Composer (macOS 26)

/// One layer edge to edge on a 1024 canvas: the 824 body of the classic drawing scaled up to fill it.
func renderLayer(_ draw: (CGContext) -> Void) -> CGImage {
    let px = 1024
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.translateBy(x: 0, y: CGFloat(px))
    ctx.scaleBy(x: 1024.0 / 824, y: -1024.0 / 824)
    ctx.translateBy(x: -100, y: -100)
    draw(ctx)
    return ctx.makeImage()!
}

try? fm.removeItem(at: iconComposer)
let layerDir = iconComposer.appendingPathComponent("Assets")
try fm.createDirectory(at: layerDir, withIntermediateDirectories: true)
writePNG(renderLayer { drawBackgroundDetails($0, small: false, glow: false) }, to: layerDir.appendingPathComponent("ground.png"))
writePNG(renderLayer { drawSignal($0, small: false, scale: 1024.0 / 824) }, to: layerDir.appendingPathComponent("signal.png"))
// Groups are listed front to back: the signal floats on glass over the ground line, on a slate fill
// (the system's automatic gradient from the middle of the classic icon's slate).
let iconJSON = """
{
  "fill" : {
    "automatic-gradient" : "srgb:0.15686,0.21176,0.26275,1.00000"
  },
  "groups" : [
    {
      "layers" : [ { "image-name" : "signal.png", "name" : "signal" } ],
      "shadow" : { "kind" : "neutral", "opacity" : 0.5 },
      "translucency" : { "enabled" : true, "value" : 0.3 }
    },
    {
      "layers" : [ { "image-name" : "ground.png", "name" : "ground" } ]
    }
  ],
  "supported-platforms" : {
    "squares" : "shared"
  }
}

"""
try iconJSON.write(to: iconComposer.appendingPathComponent("icon.json"), atomically: true, encoding: .utf8)
print(iconComposer.path)

// MARK: - Previews

func magnified(_ image: CGImage, by factor: Int) -> CGImage {
    let w = image.width * factor
    let ctx = CGContext(data: nil, width: w, height: w, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .none
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: w))
    return ctx.makeImage()!
}

/// Every size at 1:1 on a light and a dark strip, the way Finder and the Dock show them.
func contactSheet() -> CGImage {
    let sizes = [16, 32, 64, 128, 256]
    let width = sizes.reduce(0) { $0 + $1 + 32 } + 32
    let rowHeight = 256 + 48
    let ctx = CGContext(data: nil, width: width, height: rowHeight * 2, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    for (row, bg) in [rgb(0xF2F2F5), rgb(0x1E1E1E)].enumerated() {
        let y = row == 0 ? rowHeight : 0
        ctx.setFillColor(bg)
        ctx.fill(CGRect(x: 0, y: y, width: width, height: rowHeight))
        var x = 32
        for s in sizes {
            ctx.draw(render(px: s), in: CGRect(x: x, y: y + (rowHeight - s) / 2, width: s, height: s))
            x += s + 32
        }
    }
    return ctx.makeImage()!
}

if let dir = previewDir {
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    writePNG(render(px: 1024), to: dir.appendingPathComponent("icon-1024.png"))
    for px in [16, 32, 64] {
        let img = render(px: px)
        writePNG(img, to: dir.appendingPathComponent("icon-\(px).png"))
        writePNG(magnified(img, by: 512 / px), to: dir.appendingPathComponent("icon-\(px)-magnified.png"))
    }
    writePNG(contactSheet(), to: dir.appendingPathComponent("icon-sizes.png"))
    print(dir.path)
}

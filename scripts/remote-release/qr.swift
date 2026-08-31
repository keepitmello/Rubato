import AppKit
import CoreImage
import Foundation

guard CommandLine.arguments.count == 3 else {
  FileHandle.standardError.write(Data("usage: qr.swift <payload> <output.png>\n".utf8))
  exit(2)
}
let payload = CommandLine.arguments[1]
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(1) }
filter.setValue(Data(payload.utf8), forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let image = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { exit(1) }
let representation = NSBitmapImageRep(ciImage: image)
guard let png = representation.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: output, options: .atomic)

// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "t3-dictate",
  platforms: [.macOS("26.0")],
  targets: [
    .executableTarget(name: "t3-dictate", path: "Sources/t3-dictate")
  ]
)

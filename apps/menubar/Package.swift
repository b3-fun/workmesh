// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WorkmeshMenuBar",
    platforms: [.macOS(.v13)], // MenuBarExtra requires macOS 13 (Ventura)
    targets: [
        .executableTarget(
            name: "WorkmeshMenuBar",
            path: "Sources/WorkmeshMenuBar"
        )
    ]
)

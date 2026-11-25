import AppKit
import Combine
import CryptoKit
import Foundation

/// Runs an update and keeps what the update window shows: `workmesh update`
/// as a child process (not through the daemon, which restarts mid-update),
/// and the menu bar app's own replacement from the release zip.
@MainActor
final class UpdateRunner: ObservableObject {
    enum Phase: Equatable {
        case idle
        /// `workmesh update` is running.
        case running
        /// It exited 0: updated, or already current.
        case finished
        /// It exited 1 (it says whether it rolled back), another code, or didn't start.
        case failed(Int32)
        /// It exited 3: this install can't be updated by it (it says what to do).
        case cantUpdate
        /// Downloading, checking and swapping in the menu bar app.
        case appUpdating
        case appFailed(String)
        case relaunching
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var log = ""
    /// The versions this run goes from and to, as the daemon said before it started.
    @Published private(set) var from: String?
    @Published private(set) var target: String?
    /// After a good run, the daemon's version once it answers again.
    @Published private(set) var nowOn: String?
    /// After a good run, still reading the restarted daemon.
    @Published private(set) var waitingForDaemon = false
    /// The menu bar app release newer than this app, offered once the run is done.
    @Published private(set) var appOffer: UpdateInfo.MenubarRelease?
    /// The version the app update is installing.
    @Published private(set) var appTarget: String?

    /// Called when the install changed (or may have): the menu reads /update again.
    var onInstallChanged: (() -> Void)?

    private let client = DaemonClient()
    private var process: Process?
    private static let maxLog = 200_000
    /// WORKMESH_DEV_AUTOUPDATE runs also print the log, for development.
    private let echo = ProcessInfo.processInfo.environment["WORKMESH_DEV_AUTOUPDATE"] != nil
    /// WORKMESH_DEV_AUTOUPDATE=cli+app also takes the menu bar app offer after a good run.
    private let devTakeAppOffer = ProcessInfo.processInfo.environment["WORKMESH_DEV_AUTOUPDATE"] == "cli+app"

    var isBusy: Bool {
        switch phase {
        case .running, .appUpdating, .relaunching: return true
        default: return false
        }
    }

    // MARK: workmesh update

    func runCLI(_ info: UpdateInfo) {
        guard !isBusy, info.canRun else { return }
        reset()
        from = info.current
        target = info.latest
        // Remember the app release now: the daemon is down for a while mid-update.
        appOffer = Self.newerApp(info.menubar)
        phase = .running
        let argv = info.run
        do {
            try launch(argv)
        } catch {
            append("Couldn't start \(argv[0]): \(error.localizedDescription)")
            phase = .failed(-1)
        }
    }

    private func launch(_ argv: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: argv[0])
        p.arguments = Array(argv.dropFirst())
        var env = ProcessInfo.processInfo.environment
        env["NO_COLOR"] = "1"
        env.removeValue(forKey: "WORKMESH_DEV_AUTOUPDATE")
        // An app opened from Finder has a bare PATH; npm and friends sit next to node.
        let dir = (argv[0] as NSString).deletingLastPathComponent
        env["PATH"] = [dir, env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe

        let reader = LineReader()
        // The runner lives as long as the app (AppModel holds it), so the handlers hold it strongly.
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let text = reader.feed(data)
            guard !text.isEmpty else { return }
            Task { @MainActor in self.appendRaw(text) }
        }
        p.terminationHandler = { proc in
            let code = proc.terminationStatus
            let signalled = proc.terminationReason == .uncaughtSignal
            // Let the last output arrive; a process the update left running
            // may hold the pipe open, so don't wait for its end.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) {
                pipe.fileHandleForReading.readabilityHandler = nil
                let rest = reader.flush()
                Task { @MainActor in
                    if !rest.isEmpty { self.appendRaw(rest) }
                    self.finishCLI(code: signalled ? -code : code)
                }
            }
        }
        try p.run()
        process = p
    }

    private func finishCLI(code: Int32) {
        process = nil
        switch code {
        case 0: phase = .finished
        case 3: phase = .cantUpdate
        default: phase = .failed(code)
        }
        onInstallChanged?()
        guard code == 0 else {
            appOffer = nil
            return
        }
        // The daemon restarts at the end of an update: read it again once it's back.
        waitingForDaemon = true
        Task {
            let deadline = Date().addingTimeInterval(60)
            var info: UpdateInfo?
            while Date() < deadline {
                if let u = try? await client.fetchUpdate() {
                    info = u
                    // Up on the new version, or long enough that it won't change.
                    if u.current == target || Date() > deadline.addingTimeInterval(-40) { break }
                }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
            waitingForDaemon = false
            if let info {
                nowOn = info.current
                if let m = Self.newerApp(info.menubar) { appOffer = m }
            }
            onInstallChanged?()
            if devTakeAppOffer, let offer = appOffer {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                updateApp(offer)
            }
        }
    }

    /// The release's menu bar app, when it's newer than this one.
    static func newerApp(_ m: UpdateInfo.MenubarRelease?) -> UpdateInfo.MenubarRelease? {
        guard let m, let have = AppSelfUpdate.currentVersion, ReleaseVersion.isNewer(m.version, than: have) else { return nil }
        return m
    }

    // MARK: The menu bar app

    func updateApp(_ release: UpdateInfo.MenubarRelease) {
        guard !isBusy else { return }
        // After a good `workmesh update` the app's steps follow its output; otherwise they start afresh.
        if phase != .finished { reset() }
        if !log.isEmpty { append("") }
        appTarget = release.version
        phase = .appUpdating
        Task.detached(priority: .userInitiated) {
            let say: @Sendable (String) -> Void = { line in Task { @MainActor in self.append(line) } }
            do {
                let app = try await AppSelfUpdate.install(release, log: say)
                await self.relaunch(app, version: release.version)
            } catch {
                let message = (error as? AppSelfUpdate.Failure)?.message ?? error.localizedDescription
                await self.appFailed(message)
            }
        }
    }

    private func appFailed(_ message: String) {
        append(message)
        phase = .appFailed(message)
    }

    private func relaunch(_ app: URL, version: String) async {
        phase = .relaunching
        append("Relaunching Workmesh \(version)")
        try? await Task.sleep(nanoseconds: 900_000_000)
        do {
            try AppSelfUpdate.relaunch(app)
        } catch {
            appFailed("The new app is in place, but it couldn't be started: \(error.localizedDescription). Open Workmesh.app again.")
            return
        }
        NSApplication.shared.terminate(nil)
    }

    // MARK: Log

    private func reset() {
        log = ""
        from = nil
        target = nil
        nowOn = nil
        appOffer = nil
        appTarget = nil
        waitingForDaemon = false
    }

    private func append(_ line: String) {
        appendRaw(line + "\n")
    }

    private func appendRaw(_ text: String) {
        if echo { FileHandle.standardOutput.write(Data(text.utf8)) }
        log += text
        if log.count > Self.maxLog { log = String(log.suffix(Self.maxLog)) }
    }

    /// Snapshot mode: a window in a given state, without running anything.
    func seed(phase: Phase, log: String, from: String?, target: String?, nowOn: String? = nil,
              appOffer: UpdateInfo.MenubarRelease? = nil, appTarget: String? = nil) {
        self.phase = phase
        self.log = log
        self.from = from
        self.target = target
        self.nowOn = nowOn
        self.appOffer = appOffer
        self.appTarget = appTarget
    }
}

/// Splits a child's output into whole lines, without color codes and with
/// carriage-return progress lines kept as lines. Fed from the pipe's queue.
private final class LineReader: @unchecked Sendable {
    private var buffer = Data()
    private let lock = NSLock()

    /// The complete lines in what has arrived so far, each ending in "\n".
    func feed(_ data: Data) -> String {
        lock.lock()
        defer { lock.unlock() }
        buffer.append(data)
        guard let last = buffer.lastIndex(where: { $0 == 0x0A || $0 == 0x0D }) else { return "" }
        let complete = buffer[buffer.startIndex...last]
        buffer = Data(buffer[buffer.index(after: last)...])
        return Self.clean(complete)
    }

    /// Whatever is left, as a last line.
    func flush() -> String {
        lock.lock()
        defer { lock.unlock() }
        guard !buffer.isEmpty else { return "" }
        let out = Self.clean(buffer + Data([0x0A]))
        buffer.removeAll()
        return out
    }

    private static let ansi = try! NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]|\u{1B}\\][^\u{07}]*\u{07}")

    private static func clean(_ data: Data) -> String {
        var s = String(decoding: data, as: UTF8.self)
        s = ansi.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        s = s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        // Collapse runs of blank lines a progress bar leaves behind.
        while s.contains("\n\n\n") { s = s.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
        return s
    }
}

// MARK: - Replacing the menu bar app

/// Downloads the release's menu bar zip, checks it against the release's
/// SHA-256, unpacks it, checks it is this app at the promised version, swaps
/// it in where this app runs (the previous one kept) and relaunches.
enum AppSelfUpdate {
    struct Failure: Error {
        let message: String
        init(_ message: String) { self.message = message }
    }

    static var bundleURL: URL { Bundle.main.bundleURL }
    static var bundleId: String? { Bundle.main.bundleIdentifier }
    static var currentVersion: String? { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String }

    static var previousDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Workmesh/menubar-previous", isDirectory: true)
    }

    /// Why this app can't replace itself where it runs, in plain words; nil when it can.
    static func locationProblem() -> String? {
        let url = bundleURL
        guard url.pathExtension == "app", bundleId != nil, currentVersion != nil else {
            return "This menu bar app isn't running from an app bundle (a development build), so there's nothing to replace."
        }
        if url.path.contains("/AppTranslocation/") {
            return "macOS runs this Workmesh.app from a temporary read-only copy (App Translocation), so it can't replace itself. Move Workmesh.app to your Applications folder, open it from there, and try again."
        }
        if (try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly == true {
            return "Workmesh.app runs from a read-only volume, such as a disk image, so it can't replace itself. Copy it to your Applications folder, open it from there, and try again."
        }
        let fm = FileManager.default
        let parent = url.deletingLastPathComponent()
        if !fm.isWritableFile(atPath: parent.path) || !fm.isWritableFile(atPath: url.path) {
            return "Workmesh can't write to \(tilde(parent.path)), so it can't replace itself there. Move Workmesh.app to ~/Applications, open it from there, and try again."
        }
        return nil
    }

    /// https, or plain http to this Mac (the mock daemon serves its zip that way).
    static func isAllowed(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https": return url.host != nil
        case "http": return url.host == "127.0.0.1"
        default: return false
        }
    }

    static func install(_ r: UpdateInfo.MenubarRelease, log: @escaping @Sendable (String) -> Void) async throws -> URL {
        if let problem = locationProblem() { throw Failure(problem) }
        guard let ownId = bundleId else { throw Failure("This app has no bundle identifier, so the download can't be matched to it.") }
        guard isAllowed(r.url) else {
            throw Failure("The release's download link isn't https (\(r.url.absoluteString)), so nothing was downloaded.")
        }
        guard r.sha256.count == 64, r.sha256.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            throw Failure("The release has no usable SHA-256 to check the download against, so nothing was downloaded.")
        }
        let fm = FileManager.default
        let app = bundleURL
        let staging = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true)
        defer { try? fm.removeItem(at: staging) }
        let dev = ProcessInfo.processInfo.environment["WORKMESH_DEV_AUTOUPDATE"] != nil

        log("Downloading \(r.url.absoluteString)")
        let zip = staging.appendingPathComponent("menubar.zip")
        try await download(r.url, to: zip)
        let size = (try? fm.attributesOfItem(atPath: zip.path)[.size] as? Int) ?? 0
        log("Downloaded \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))")
        if dev { log("  xattrs on the download: \(xattrNames(zip.path))") }

        let digest = try sha256(of: zip)
        guard digest == r.sha256 else {
            throw Failure("The download's SHA-256 (\(digest.prefix(12))…) doesn't match the release's (\(r.sha256.prefix(12))…), so it was thrown away. Workmesh.app is unchanged.")
        }
        log("SHA-256 matches the release: \(digest)")

        let unpacked = staging.appendingPathComponent("unpacked", isDirectory: true)
        try runTool("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path], what: "Unpacking the zip")
        let apps = (try fm.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil)).filter { $0.pathExtension == "app" }
        guard apps.count == 1, let fresh = apps.first else {
            throw Failure("The zip doesn't hold exactly one app. Workmesh.app is unchanged.")
        }
        let info = infoPlist(of: fresh)
        let id = info["CFBundleIdentifier"] as? String
        let version = info["CFBundleShortVersionString"] as? String
        guard id == ownId else {
            throw Failure("The downloaded app is \(id ?? "unidentified"), not \(ownId). Workmesh.app is unchanged.")
        }
        guard version == r.version else {
            throw Failure("The downloaded app is version \(version ?? "unknown"), not \(r.version). Workmesh.app is unchanged.")
        }
        guard let exe = info["CFBundleExecutable"] as? String,
              fm.isExecutableFile(atPath: fresh.appendingPathComponent("Contents/MacOS/\(exe)").path)
        else { throw Failure("The downloaded app has no program in it. Workmesh.app is unchanged.") }
        log("Unpacked \(fresh.lastPathComponent) \(r.version) (\(ownId))")
        if dev { log("  xattrs on the unpacked app: \(xattrNames(fresh.path))") }
        // This download isn't quarantined, but a zip made from a downloaded app carries the flag inside it.
        if getxattr(fresh.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0 {
            log("The release's app is marked as downloaded from the internet: macOS asks once before opening it.")
        }

        // Keep the app that runs now, then swap the new one into its place.
        let previous = previousDir
        try? fm.removeItem(at: previous)
        do {
            try fm.createDirectory(at: previous, withIntermediateDirectories: true)
            try fm.copyItem(at: app, to: previous.appendingPathComponent(app.lastPathComponent))
        } catch {
            throw Failure("Couldn't keep a copy of the current app in \(tilde(previous.path)) (\(error.localizedDescription)), so it wasn't replaced.")
        }
        log("Kept the current app (\(currentVersion ?? "?")) in \(tilde(previous.path))")
        do {
            _ = try fm.replaceItemAt(app, withItemAt: fresh)
        } catch {
            throw Failure("Couldn't replace \(tilde(app.path)): \(error.localizedDescription). The previous app is in \(tilde(previous.path)).")
        }
        log("Replaced \(tilde(app.path)) with \(r.version)")
        if dev { log("  xattrs on the installed app: \(xattrNames(app.path))") }
        return app
    }

    private static func download(_ url: URL, to dest: URL) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let (tmp, response): (URL, URLResponse)
        do {
            (tmp, response) = try await session.download(from: url)
        } catch {
            throw Failure("The download failed: \(error.localizedDescription). Workmesh.app is unchanged.")
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw Failure("The download answered \(code). Workmesh.app is unchanged.")
        }
        if let final = http.url, !isAllowed(final) {
            throw Failure("The download was redirected off https (\(final.absoluteString)). Workmesh.app is unchanged.")
        }
        try FileManager.default.moveItem(at: tmp, to: dest)
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func infoPlist(of app: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              let obj = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return [:] }
        return obj
    }

    private static func runTool(_ path: String, _ args: [String], what: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let err = Pipe()
        p.standardError = err
        p.standardOutput = FileHandle.nullDevice
        try p.run()
        let text = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            let detail = text.trimmingCharacters(in: .whitespacesAndNewlines)
            throw Failure("\(what) failed\(detail.isEmpty ? "" : ": \(detail)"). Workmesh.app is unchanged.")
        }
    }

    /// Starts the app at `app` once this process has exited, from a shell in
    /// its own session (so a LaunchAgent stopping this job doesn't take it
    /// along). Under a LaunchAgent with KeepAlive, launchd has usually started
    /// it again already; then the shell leaves it at that.
    static func relaunch(_ app: URL) throws {
        let info = infoPlist(of: app)
        let exe = app.appendingPathComponent("Contents/MacOS/\(info["CFBundleExecutable"] as? String ?? "Workmesh")").path
        let script = """
        pid="$1"; exe="$2"; shift 2
        i=0
        while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done
        sleep 1
        pgrep -f -x -- "$exe" >/dev/null 2>&1 && exit 0
        exec /usr/bin/open "$@"
        """
        var args = ["/bin/sh", "-c", script, "sh", String(getpid()), exe]
        // Keep a custom config/state location (a LaunchAgent's or a dev run's).
        let env = ProcessInfo.processInfo.environment
        for key in ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] {
            if let v = env[key], !v.isEmpty { args += ["--env", "\(key)=\(v)"] }
        }
        args.append(app.path)
        // `open` hands its environment to the app; leave out the development switches.
        let keep = env.filter { !$0.key.hasPrefix("WORKMESH_DEV_") && !$0.key.hasPrefix("WORKMESH_SNAPSHOT") }
        try spawnDetached(args, env: keep.map { "\($0.key)=\($0.value)" })
    }

    private static func spawnDetached(_ args: [String], env: [String]) throws {
        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
        let cargs = args.map { strdup($0) } + [nil]
        let cenv = env.map { strdup($0) } + [nil]
        defer { (cargs + cenv).forEach { free($0) } }
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, args[0], &actions, &attr, cargs, cenv)
        guard rc == 0 else { throw Failure(String(cString: strerror(rc))) }
    }

    /// The extended attribute names on a file, for development logs.
    static func xattrNames(_ path: String) -> String {
        let size = listxattr(path, nil, 0, XATTR_NOFOLLOW)
        guard size > 0 else { return "none" }
        var buf = [CChar](repeating: 0, count: size)
        let n = listxattr(path, &buf, size, XATTR_NOFOLLOW)
        guard n > 0 else { return "none" }
        let names = buf.prefix(n).split(separator: 0).map { String(decoding: $0.map { UInt8(bitPattern: $0) }, as: UTF8.self) }
        return names.isEmpty ? "none" : names.joined(separator: ", ")
    }

    static func tilde(_ path: String) -> String {
        let home = NSHomeDirectory()
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }
}

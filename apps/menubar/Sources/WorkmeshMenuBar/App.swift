import SwiftUI

@main
struct WorkmeshMenuBarApp: App {
    @StateObject private var model: AppModel

    init() {
        let m = AppModel(snapshot: SnapshotMode.isEnabled)
        _model = StateObject(wrappedValue: m)
        // WORKMESH_SNAPSHOT: render the menu to a PNG and exit (development).
        if SnapshotMode.isEnabled { SnapshotMode.run(model: m) }
    }

    var body: some Scene {
        MenuBarExtra(isInserted: .constant(!SnapshotMode.isEnabled)) {
            MenuContent(model: model)
        } label: {
            // @StateObject drives re-evaluation, so the icon tracks state live.
            Image(nsImage: StatusIcon.image(for: model.blip))
        }
        .menuBarExtraStyle(.window)
    }
}

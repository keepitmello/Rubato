import SwiftUI

@main
struct RubatoChatDemoApp: App {
    @StateObject private var appModel = AppModel.connectedToHub()

    var body: some Scene {
        WindowGroup {
            ConversationListView(appModel: appModel)
                .tint(.blue)
        }
    }
}

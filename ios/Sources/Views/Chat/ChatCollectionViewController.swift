import ChatLayout
import Combine
import QuickLook
import SwiftUI
import UIKit

struct ChatCollectionContainer: UIViewControllerRepresentable {
    @ObservedObject var store: ChatRoomStore

    func makeUIViewController(context: Context) -> ChatCollectionViewController {
        ChatCollectionViewController(store: store)
    }

    func updateUIViewController(_ uiViewController: ChatCollectionViewController, context: Context) {
        uiViewController.refreshExtendedLayoutAnchor()
    }

    static func dismantleUIViewController(_ uiViewController: ChatCollectionViewController, coordinator: ()) {
        uiViewController.stopObserving()
    }
}

@MainActor
final class ChatCollectionViewController: UIViewController {
    private enum Section: Hashable {
        case messages
    }

    private let store: ChatRoomStore
    private let chatLayout = CollectionViewChatLayout()
    private lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: chatLayout)
    private var dataSource: UICollectionViewDiffableDataSource<Section, UUID>!
    private var cancellables: Set<AnyCancellable> = []
    private var renderedMessages: [ChatMessage] = []
    private var measuredHeights: [UUID: (width: CGFloat, height: CGFloat, stamp: Int)] = [:]
    private var composerHost: UIHostingController<MessageComposerView>!
    private var bottomButtonHost: UIHostingController<ScrollToBottomControl>!
    private var previewURL: URL?
    private var hasAppliedInitialSnapshot = false
    private var isApplyingSnapshot = false
    private var pendingMessages: [ChatMessage]?

    init(store: ChatRoomStore) {
        self.store = store
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureLayout()
        configureCollectionView()
        configureComposer()
        configureScrollToBottomButton()
        configureDataSource()
        observeStore()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        collectionView.collectionViewLayout.invalidateLayout()
    }

    func stopObserving() {
        cancellables.removeAll()
    }

    func refreshExtendedLayoutAnchor() {
        setExtendedLayoutAnchor(store.extendedLayoutAnchorMessageID)
    }

    private func configureLayout() {
        view.backgroundColor = .systemBackground
        chatLayout.delegate = self
        chatLayout.settings.estimatedItemSize = CGSize(width: 360, height: 96)
        chatLayout.settings.interItemSpacing = 0
        chatLayout.settings.interSectionSpacing = 0
        chatLayout.settings.additionalInsets = UIEdgeInsets(top: 4, left: 0, bottom: 10, right: 0)
        chatLayout.keepContentOffsetAtBottomOnBatchUpdates = true
        chatLayout.keepContentAtBottomOfVisibleArea = true
        chatLayout.processOnlyVisibleItemsOnAnimatedBatchUpdates = false
    }

    private func configureCollectionView() {
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = .clear
        collectionView.alwaysBounceVertical = true
        collectionView.keyboardDismissMode = .interactive
        collectionView.contentInsetAdjustmentBehavior = .always
        collectionView.automaticallyAdjustsScrollIndicatorInsets = true
        collectionView.showsHorizontalScrollIndicator = false
        collectionView.delegate = self
        collectionView.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "message")
        view.addSubview(collectionView)
    }

    private func configureComposer() {
        composerHost = UIHostingController(rootView: MessageComposerView(store: store))
        composerHost.view.translatesAutoresizingMaskIntoConstraints = false
        composerHost.view.backgroundColor = .clear
        composerHost.sizingOptions = [.intrinsicContentSize]
        addChild(composerHost)
        view.addSubview(composerHost.view)
        composerHost.didMove(toParent: self)

        view.keyboardLayoutGuide.followsUndockedKeyboard = true
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: composerHost.view.topAnchor),

            composerHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composerHost.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
    }

    private func configureScrollToBottomButton() {
        bottomButtonHost = UIHostingController(
            rootView: ScrollToBottomControl { [weak self] in
                self?.scrollToBottom(animated: true)
            }
        )
        bottomButtonHost.view.translatesAutoresizingMaskIntoConstraints = false
        bottomButtonHost.view.backgroundColor = .clear
        bottomButtonHost.view.alpha = 0
        bottomButtonHost.view.isUserInteractionEnabled = false
        addChild(bottomButtonHost)
        view.addSubview(bottomButtonHost.view)
        bottomButtonHost.didMove(toParent: self)

        NSLayoutConstraint.activate([
            bottomButtonHost.view.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            bottomButtonHost.view.bottomAnchor.constraint(equalTo: composerHost.view.topAnchor, constant: -10),
            bottomButtonHost.view.widthAnchor.constraint(equalToConstant: 44),
            bottomButtonHost.view.heightAnchor.constraint(equalToConstant: 44)
        ])
    }

    private func configureDataSource() {
        dataSource = UICollectionViewDiffableDataSource<Section, UUID>(
            collectionView: collectionView
        ) { [weak self] collectionView, indexPath, messageID in
            guard let self,
                  let messageIndex = renderedMessages.firstIndex(where: { $0.id == messageID }) else {
                return nil
            }

            let message = renderedMessages[messageIndex]
            let presentation = presentation(for: messageIndex, in: renderedMessages)
            let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "message", for: indexPath)

            cell.contentConfiguration = UIHostingConfiguration {
                MessageRowView(
                    message: message,
                    groupPosition: presentation.groupPosition,
                    showDate: presentation.showsDateSeparator,
                    audioPlayback: store.audioPlayer,
                    onReply: { [weak self] message in
                        self?.store.setReply(to: message)
                    },
                    onReaction: { [weak self] id, emoji in
                        self?.store.toggleReaction(messageID: id, emoji: emoji)
                    },
                    onRetryResponse: { [weak self] id in
                        self?.store.retryResponse(messageID: id)
                    },
                    onRetrySending: { [weak self] id in
                        self?.store.retrySending(messageID: id)
                    },
                    onOpenAttachment: { [weak self] attachment in
                        self?.presentPreview(for: attachment)
                    }
                )
                .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
            }
            .margins(.all, 0)
            cell.backgroundColor = .clear
            return cell
        }
    }

    private func observeStore() {
        store.$messages
            .receive(on: RunLoop.main)
            .sink { [weak self] messages in
                self?.enqueueApply(messages)
            }
            .store(in: &cancellables)

        store.$extendedLayoutAnchorMessageID
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] messageID in
                self?.setExtendedLayoutAnchor(messageID)
            }
            .store(in: &cancellables)
    }

    private struct MessagePresentation: Equatable {
        var groupPosition: MessageGroupPosition
        var showsDateSeparator: Bool
    }

    private func enqueueApply(_ messages: [ChatMessage]) {
        guard !isApplyingSnapshot else {
            pendingMessages = messages
            return
        }
        isApplyingSnapshot = true
        applyNow(messages)
    }

    private func applyNow(_ messages: [ChatMessage]) {
        let oldIDs = renderedMessages.map(\.id)
        let newIDs = messages.map(\.id)
        let oldByID = Dictionary(uniqueKeysWithValues: renderedMessages.map { ($0.id, $0) })
        let oldPresentation = presentationMap(for: renderedMessages)
        let newPresentation = presentationMap(for: messages)
        let changedIDs = messages.compactMap { message -> UUID? in
            guard let old = oldByID[message.id] else { return nil }
            guard old != message || oldPresentation[message.id] != newPresentation[message.id] else {
                return nil
            }
            return message.id
        }

        let isInitial = !hasAppliedInitialSnapshot
        let prependedCount: Int = {
            guard !oldIDs.isEmpty, newIDs.count > oldIDs.count else { return 0 }
            let suffix = Array(newIDs.suffix(oldIDs.count))
            return suffix == oldIDs ? newIDs.count - oldIDs.count : 0
        }()
        let positionSnapshot = prependedCount > 0
            ? chatLayout.getContentOffsetSnapshot(from: .top)
            : nil
        let wasNearBottom = isNearBottom

        var snapshot = NSDiffableDataSourceSnapshot<Section, UUID>()
        snapshot.appendSections([.messages])
        snapshot.appendItems(newIDs, toSection: .messages)
        if !changedIDs.isEmpty {
            snapshot.reconfigureItems(changedIDs)
            let paths = changedIDs.compactMap { id -> IndexPath? in
                guard let item = newIDs.firstIndex(of: id) else { return nil }
                return IndexPath(item: item, section: 0)
            }
            chatLayout.reconfigureItems(at: paths)
        }

        let hasStructuralChanges = oldIDs != newIDs
        for id in changedIDs {
            measuredHeights[id] = nil
        }
        renderedMessages = messages

        dataSource.apply(
            snapshot,
            animatingDifferences: !isInitial && hasStructuralChanges
        ) { [weak self] in
            guard let self else { return }
            collectionView.layoutIfNeeded()

            if let positionSnapshot, prependedCount > 0 {
                let adjusted = ChatLayoutPositionSnapshot(
                    indexPath: IndexPath(
                        item: positionSnapshot.indexPath.item + prependedCount,
                        section: positionSnapshot.indexPath.section
                    ),
                    edge: positionSnapshot.edge,
                    offset: positionSnapshot.offset
                )
                chatLayout.restoreContentOffset(with: adjusted)
            } else if isInitial || wasNearBottom {
                scrollToBottom(animated: !isInitial)
            }

            hasAppliedInitialSnapshot = true
            setExtendedLayoutAnchor(store.extendedLayoutAnchorMessageID)
            updateBottomButtonVisibility()

            isApplyingSnapshot = false
            if let pendingMessages {
                self.pendingMessages = nil
                enqueueApply(pendingMessages)
            }
        }
    }

    private func presentationMap(for messages: [ChatMessage]) -> [UUID: MessagePresentation] {
        Dictionary(uniqueKeysWithValues: messages.indices.map { index in
            (messages[index].id, presentation(for: index, in: messages))
        })
    }

    private func presentation(for index: Int, in messages: [ChatMessage]) -> MessagePresentation {
        let current = messages[index]
        let previousMatches = index > messages.startIndex
            && messages[index - 1].role == current.role
            && current.createdAt.timeIntervalSince(messages[index - 1].createdAt) < 300
        let nextMatches = index < messages.index(before: messages.endIndex)
            && messages[index + 1].role == current.role
            && messages[index + 1].createdAt.timeIntervalSince(current.createdAt) < 300

        let groupPosition: MessageGroupPosition
        switch (previousMatches, nextMatches) {
        case (false, false): groupPosition = .single
        case (false, true): groupPosition = .first
        case (true, true): groupPosition = .middle
        case (true, false): groupPosition = .last
        }

        let showsDateSeparator = index == messages.startIndex
            || !Calendar.current.isDate(messages[index - 1].createdAt, inSameDayAs: current.createdAt)
        return MessagePresentation(
            groupPosition: groupPosition,
            showsDateSeparator: showsDateSeparator
        )
    }

    private func setExtendedLayoutAnchor(_ messageID: UUID?) {
        guard let messageID,
              let item = dataSource?.snapshot().indexOfItem(messageID) else {
            chatLayout.settings.indexPathForExtendedLayout = nil
            return
        }
        chatLayout.settings.indexPathForExtendedLayout = IndexPath(item: item, section: 0)
    }

    private var isNearBottom: Bool {
        let inset = collectionView.adjustedContentInset
        let visibleBottom = collectionView.contentOffset.y + collectionView.bounds.height - inset.bottom
        return chatLayout.collectionViewContentSize.height - visibleBottom < 90
    }

    private func scrollToBottom(animated: Bool) {
        collectionView.layoutIfNeeded()
        let inset = collectionView.adjustedContentInset
        let y = max(
            -inset.top,
            chatLayout.collectionViewContentSize.height - collectionView.bounds.height + inset.bottom
        )
        collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
        if !animated {
            updateBottomButtonVisibility()
        }
    }

    private func updateBottomButtonVisibility() {
        let visible = !isNearBottom && !renderedMessages.isEmpty
        UIView.animate(withDuration: 0.18) {
            self.bottomButtonHost.view.alpha = visible ? 1 : 0
        }
        bottomButtonHost.view.isUserInteractionEnabled = visible
    }

    private func presentPreview(for attachment: ChatAttachment) {
        previewURL = attachment.localURL
        let preview = QLPreviewController()
        preview.dataSource = self
        present(preview, animated: true)
    }
}

extension ChatCollectionViewController: ChatLayoutDelegate {
    func sizeForItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath) -> ItemSize {
        guard indexPath.item < renderedMessages.count else {
            return .estimated(CGSize(width: chatLayout.layoutFrame.width, height: 96))
        }
        let message = renderedMessages[indexPath.item]
        let width = chatLayout.layoutFrame.width > 1 ? chatLayout.layoutFrame.width : UIScreen.main.bounds.width
        return .exact(measuredSize(for: message, width: width))
    }

    private func measuredSize(for message: ChatMessage, width: CGFloat) -> CGSize {
        let stamp = message.text.hashValue ^ message.attachments.count ^ Int(message.createdAt.timeIntervalSince1970)
        if let cached = measuredHeights[message.id], abs(cached.width - width) < 0.5, cached.stamp == stamp {
            return CGSize(width: width, height: cached.height)
        }
        let index = renderedMessages.firstIndex(where: { $0.id == message.id }) ?? 0
        let presentation = presentation(for: index, in: renderedMessages)
        let root = MessageRowView(
            message: message,
            groupPosition: presentation.groupPosition,
            showDate: presentation.showsDateSeparator,
            audioPlayback: store.audioPlayer,
            onReply: { _ in },
            onReaction: { _, _ in },
            onRetryResponse: { _ in },
            onRetrySending: { _ in },
            onOpenAttachment: { _ in }
        )
        .frame(width: width)
        let host = UIHostingController(rootView: root)
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        let fitted = host.sizeThatFits(in: CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        let height = max(ceil(fitted.height), 1)
        measuredHeights[message.id] = (width, height, stamp)
        return CGSize(width: width, height: height)
    }

    func alignmentForItem(_ chatLayout: CollectionViewChatLayout, at indexPath: IndexPath) -> ChatItemAlignment {
        .fullWidth
    }

    func initialLayoutAttributesForInsertedItem(
        _ chatLayout: CollectionViewChatLayout,
        at indexPath: IndexPath,
        modifying originalAttributes: ChatLayoutAttributes,
        on state: InitialAttributesRequestType
    ) {
        originalAttributes.alpha = 0
        let isUser = indexPath.item < renderedMessages.count && renderedMessages[indexPath.item].role == .user
        originalAttributes.transform = CGAffineTransform(
            translationX: isUser ? 22 : 0,
            y: isUser ? 4 : 12
        )
    }

    func finalLayoutAttributesForDeletedItem(
        _ chatLayout: CollectionViewChatLayout,
        at indexPath: IndexPath,
        modifying originalAttributes: ChatLayoutAttributes
    ) {
        originalAttributes.alpha = 0
        originalAttributes.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
    }
}

extension ChatCollectionViewController: UICollectionViewDelegate {
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateBottomButtonVisibility()

        let threshold = -scrollView.adjustedContentInset.top + 120
        guard scrollView.contentOffset.y <= threshold,
              store.canLoadPrevious,
              !store.isLoadingPrevious else { return }

        Task { [weak self] in
            await self?.store.loadPrevious()
        }
    }
}

extension ChatCollectionViewController: QLPreviewControllerDataSource {
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        previewURL == nil ? 0 : 1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
        (previewURL ?? FileManager.default.temporaryDirectory) as NSURL
    }
}

private struct ScrollToBottomControl: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .bold))
                .frame(width: 42, height: 42)
        }
        .buttonStyle(.plain)
        .rubatoGlass(in: Circle(), interactive: true)
        .accessibilityLabel("최신 메시지로 이동")
    }
}

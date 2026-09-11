# Empty, Error & Onboarding States — Designing for Every Moment

The measure of an interface's quality is not how it behaves when everything works perfectly — it is how it behaves when things are missing, broken, or unfamiliar. Empty states, error states, and onboarding flows are the moments where trust is built or broken. They are not edge cases. They are some of the most frequently encountered states in any application, and they deserve as much design attention as the happy path.

---

## Empty State Patterns

An empty state occurs whenever a view has no content to display. There are five distinct types, each requiring a different design response.

### First-Use Empty State

The user has just arrived at a feature for the first time. There is no data because they have not created any yet. This is simultaneously an empty state and an onboarding moment.

**Design approach:**

- **Illustration or icon:** A friendly, relevant visual that communicates the purpose of this space. Not decorative — functional. It answers "What will go here?"
- **Headline:** Clear, benefit-oriented. "Your projects live here" rather than "No projects found."
- **Description:** One to two sentences explaining what this feature does and why it is valuable.
- **Primary CTA:** A prominent button for the single most important first action. "Create your first project", "Import your data", "Invite your team."
- **Secondary option (if applicable):** A less prominent link to an alternative path. "Or import from CSV", "Browse templates."

**Example layout:**

```
    ┌─────────────────────────────────┐
    │                                 │
    │        [Illustration]           │
    │                                 │
    │     Your projects live here     │
    │                                 │
    │  Create a project to organize   │
    │  your work and collaborate      │
    │  with your team.                │
    │                                 │
    │    [ Create First Project ]     │
    │                                 │
    │     or browse templates         │
    │                                 │
    └─────────────────────────────────┘
```

### No-Results Empty State

The user searched or filtered and nothing matched. The system has content, but the current query excludes all of it.

**Design approach:**

- Acknowledge the search/filter terms explicitly: "No results for 'quantum physics'."
- Offer search tips: "Try different keywords" or "Check your spelling."
- Suggest related or popular content: "Popular topics: Machine Learning, Data Science..."
- Provide a clear path to clear filters or broaden the search.
- Never show a completely blank screen for a no-results state. The user needs to understand what happened and what to try next.

### No-Data Empty State

The feature area exists and the user has used it before, but there is currently no data to display. Examples: an empty inbox after archiving all messages, a completed task list, a time period with no activity.

**Design approach:**

- Frame positively when possible. An empty inbox is an achievement: "You're all caught up!" A completed task list is satisfying: "All tasks complete."
- If the emptiness is neutral (no activity this month), explain why and offer a path forward: "No activity in February. Create a new entry to get started."
- Keep it minimal. The user is experienced; they do not need onboarding-level guidance.

### Error-Caused Empty State

The view is empty because something went wrong — a failed API call, a timeout, a server error. The user expected to see content, but the system could not deliver it.

**Design approach:**

- Be honest: "We couldn't load your messages."
- Explain briefly: "This might be a temporary server issue."
- Offer recovery: A prominent "Try Again" button. If applicable, suggest checking network connectivity.
- If cached data is available, show it with a banner: "Showing cached version. Some content may be outdated. Retry"
- Never show a generic empty state when the real cause is an error. The user needs to know the difference between "you have nothing" and "we failed to load your stuff."

### Permission-Required Empty State

The view is empty because the user has not granted a necessary permission — location access, notification permission, camera, contacts, etc.

**Design approach:**

- Explain what permission is needed and why: "Enable location access to see nearby restaurants."
- Explain the benefit, not the requirement: "Find great food within walking distance" rather than "This feature requires location permission."
- Provide a direct action: "Open Settings" button that deep-links to the relevant system settings panel.
- Offer an alternative if one exists: "Or enter your address manually."

---

## Error State Patterns

Errors are inevitable. The quality of error handling defines how resilient an application feels. Every error message must answer three questions: What happened? Why does it matter to me? What can I do about it?

### Inline Validation Errors

Displayed below individual form fields as the user fills them out.

**Design rules:**

- **Position:** Directly below the field, associated via `aria-describedby`. Never display errors only at the top of the form without connecting them to specific fields.
- **Timing:** Validate on blur (when the field loses focus), not on every keystroke. Keystroke validation is aggressive and penalizes the user before they finish typing. Exception: password strength meters, which should update in real time because they provide positive guidance.
- **Color:** Red text (`#D32F2F` or similar) for errors. The field border should also turn red. Do not rely on color alone — include an error icon for users with color vision deficiencies.
- **Language:** Specific and prescriptive. "Email must include an @ symbol" rather than "Invalid email." "Password must be at least 8 characters" rather than "Password too short."

```html
<div class="field field--error">
  <label for="email">Email address</label>
  <input
    id="email"
    type="email"
    aria-invalid="true"
    aria-describedby="email-error"
  />
  <p id="email-error" class="field__error" role="alert">
    Please enter a valid email address, like name@example.com
  </p>
</div>
```

### Form Summary Errors

Displayed at the top of a form when submission fails, listing all fields that need attention.

**Design rules:**

- Position at the top of the form, inside an `role="alert"` container.
- Move focus to the error summary on submission failure so screen readers announce it immediately.
- Each error in the summary should be a link that scrolls to and focuses the relevant field.
- Use language like "Please fix 3 errors before submitting" followed by the linked list.

```jsx
function FormErrorSummary({ errors }) {
  const summaryRef = useRef(null);

  useEffect(() => {
    if (errors.length > 0) {
      summaryRef.current?.focus();
    }
  }, [errors]);

  if (errors.length === 0) return null;

  return (
    <div
      ref={summaryRef}
      className="form-error-summary"
      role="alert"
      tabIndex={-1}
    >
      <h3>Please fix {errors.length} error{errors.length > 1 ? 's' : ''} before submitting</h3>
      <ul>
        {errors.map((error) => (
          <li key={error.field}>
            <a href={`#${error.field}`} onClick={() => {
              document.getElementById(error.field)?.focus();
            }}>
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Page-Level Error States

Full-page errors for server failures (500, 503) and other catastrophic issues.

**Design approach:**

- Use a clear, human-readable headline: "Something went wrong" or "We're having server trouble."
- Provide a brief explanation: "Our servers are temporarily unavailable. This usually resolves within a few minutes."
- Offer a retry action: A "Try Again" button that reloads the page or retries the failed request.
- Provide an escape route: Link to the home page, status page, or support contact.
- Include a reference ID if applicable, for support tickets: "Error reference: ERR-2024-A7B3."
- Never show a raw stack trace, HTTP status code, or technical error message to end users.

### Network Error State

The user's device has lost network connectivity.

**Design approach:**

- Detect offline status via `navigator.onLine` and the `offline`/`online` events.
- Show a persistent, non-dismissible banner: "You're offline. Some features may be unavailable."
- Serve cached content where available. Label it: "Showing cached version."
- Disable or gray out actions that require network connectivity, with tooltips explaining why.
- When connectivity returns, automatically dismiss the offline banner and optionally refresh stale content.

### 404 Not Found

The user navigated to a URL that does not correspond to any content.

**Design approach:**

- Friendly headline: "Page not found" (not "404 Error").
- Brief explanation: "The page you're looking for may have been moved or deleted."
- Provide recovery paths: search bar, link to home page, popular/recent pages.
- If possible, suggest similar URLs: "Did you mean /blog/getting-started?"
- Maintain the site's navigation so the user can self-recover.

### Permission Denied

The user attempted to access a resource they do not have permission to view.

**Design approach:**

- Explain clearly: "You don't have access to this project."
- Explain why if possible: "This project is restricted to the Engineering team."
- Offer a path forward: "Request access" button, or contact information for the resource owner.
- Never reveal whether the resource exists if that information is sensitive (for security, show a 404 instead of a 403 for sensitive resources).

### Rate Limited

The user has exceeded an API or action rate limit.

**Design approach:**

- Explain what happened: "You've made too many requests."
- Provide a time estimate: "Please try again in 30 seconds." Use a visible countdown timer if the wait is short.
- Explain limits proactively for power users: "Free accounts are limited to 100 API calls per hour."
- If applicable, offer an upgrade path to higher limits.

---

## Onboarding Patterns

Onboarding is the process of guiding a new user from their first encounter to their first moment of value. The best onboarding is invisible — an interface so clear it teaches itself. When explicit onboarding is necessary, it should be minimal, skippable, and goal-oriented.

### Progressive Disclosure

Features reveal themselves as users naturally encounter them, rather than being explained upfront.

**Implementation:**

- Hide advanced features behind "More options" or secondary menus initially.
- Surface feature introductions contextually: when a user first creates a document, introduce collaboration features — not during account setup.
- Use smart defaults so that beginners can be productive without configuring anything, while power users can customize later.
- This is the preferred onboarding pattern for most interfaces because it respects the user's current context and learning pace.

### Tooltip Tour (Coach Marks)

A step-by-step overlay highlighting specific UI elements with explanatory tooltips.

**Design rules:**

- **Maximum 5 steps.** More than 5 and the user is overwhelmed. Identify the 3-5 things that deliver value fastest, and skip everything else.
- **Always skippable.** A prominent "Skip tour" button on every step. Some users learn by exploration, not instruction.
- **Progress indicator.** "Step 2 of 4" so the user knows the commitment involved.
- **Highlight one element per step.** Dim the rest of the page to focus attention. The highlighted element should be interactive (the user should click the actual button, not just a "Next" button).
- **Responsive.** Coach marks must reposition correctly on different screen sizes. Test on mobile.

### Checklist (Profile Completion)

A visible list of setup tasks that guides the user through initial configuration.

**Design rules:**

- **Endowed progress:** Start the checklist at "1 of 5 complete" (with the first item pre-checked, such as "Create account") rather than "0 of 5." Research on the goal-gradient effect shows that people are more motivated to complete a sequence they have already started.
- **Clear benefit per item:** Each task should explain its value. "Add a profile photo — teammates will recognize you in conversations."
- **Non-blocking:** The checklist should guide, not gate. Users should be able to use the product without completing every checklist item.
- **Celebrate completion:** When all items are done, acknowledge it. A brief confetti animation, a "You're all set!" message, or a transition to the main interface.

```jsx
function OnboardingChecklist({ steps }) {
  const completedCount = steps.filter((s) => s.completed).length;
  const progress = (completedCount / steps.length) * 100;

  return (
    <div className="onboarding-checklist" role="region" aria-label="Setup progress">
      <div className="checklist__header">
        <h3>Get started with Acme</h3>
        <p className="checklist__progress-text">
          {completedCount} of {steps.length} complete
        </p>
        <div
          className="checklist__progress-bar"
          role="progressbar"
          aria-valuenow={completedCount}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-label={`${completedCount} of ${steps.length} steps complete`}
        >
          <div
            className="checklist__progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <ul className="checklist__steps">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`checklist__step ${step.completed ? 'checklist__step--done' : ''}`}
          >
            <span className="checklist__check" aria-hidden="true">
              {step.completed ? '✓' : '○'}
            </span>
            <div className="checklist__step-content">
              <p className="checklist__step-title">{step.title}</p>
              <p className="checklist__step-description">{step.description}</p>
              {!step.completed && (
                <button
                  className="checklist__step-action"
                  onClick={step.action}
                >
                  {step.actionLabel}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Interactive Sandbox

A pre-configured environment where users can experiment with the product without consequences.

**Design approach:**

- Pre-populate the sandbox with sample data that demonstrates the product's core value proposition.
- Clearly label the sandbox: "This is a practice workspace. Nothing here affects your real account."
- Provide guided tasks within the sandbox: "Try dragging this task to the Done column."
- Offer a clear transition from sandbox to real use: "Ready to create your own workspace? Start fresh"
- Sandbox data should be deletable and resettable.

### Sample Data (Pre-Populated)

Instead of showing an empty first-use state, pre-populate the interface with example content that demonstrates what the product looks like when active.

**Design approach:**

- Use realistic but clearly labeled sample data: "[Sample] Marketing Campaign Q1", "[Example] Weekly Team Standup."
- Show a banner: "We've added some sample data to help you explore. Delete it anytime."
- Ensure sample data exercises the product's key features — if the product has charts, the sample data should produce interesting charts.
- Provide a one-click "Clear sample data" action when the user is ready to start fresh.

### Video Walkthrough

A short video demonstrating the product's core workflow.

**Design rules:**

- **Duration:** Under 90 seconds. Under 60 seconds is ideal. Attention drops sharply after the first minute.
- **Always skippable.** A prominent "Skip" button visible throughout.
- **No audio required.** Use captions and on-screen text so the video works in sound-off environments (offices, public spaces).
- **Show the real product.** Not an abstract animation — show actual screens, real workflows, recognizable UI elements.
- **End with a CTA:** The video should transition directly into the first action: "Ready? Let's create your first project."

---

## React Error Boundary

Error boundaries catch JavaScript runtime errors in component trees and display fallback UI instead of a white screen.

```jsx
import { Component } from 'react';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Log to error reporting service
    console.error('ErrorBoundary caught:', error, errorInfo);
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback({
          error: this.state.error,
          retry: this.handleRetry,
        });
      }

      return (
        <div className="error-boundary" role="alert">
          <div className="error-boundary__content">
            <svg
              className="error-boundary__icon"
              viewBox="0 0 24 24"
              width="48"
              height="48"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" fill="none" stroke="#D32F2F" strokeWidth="2" />
              <line x1="12" y1="8" x2="12" y2="13" stroke="#D32F2F" strokeWidth="2" strokeLinecap="round" />
              <circle cx="12" cy="16.5" r="1" fill="#D32F2F" />
            </svg>

            <h2 className="error-boundary__title">
              Something went wrong
            </h2>
            <p className="error-boundary__message">
              We hit an unexpected error loading this section.
              This has been reported to our team.
            </p>
            <div className="error-boundary__actions">
              <button
                className="error-boundary__retry"
                onClick={this.handleRetry}
              >
                Try Again
              </button>
              <a href="/" className="error-boundary__home">
                Go to Home
              </a>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Usage
function App() {
  return (
    <ErrorBoundary
      fallback={({ error, retry }) => (
        <CustomErrorPage error={error} onRetry={retry} />
      )}
      onError={(error, info) => {
        errorReportingService.captureException(error, { extra: info });
      }}
    >
      <MainContent />
    </ErrorBoundary>
  );
}
```

---

## Core Principles

### Empty States Are Opportunities

Every empty state is a chance to guide the user toward their next action, teach them about a feature, or delight them with thoughtful design. An empty state that says "No data" is a missed opportunity. An empty state that says "Your inbox is empty — nice work!" with a cheerful illustration turns a void into a moment of satisfaction.

### Error Messages Must Be Human-Readable and Actionable

An error message is a conversation between the system and a confused, possibly frustrated, human. It must:

1. **Say what happened** in plain language the user understands (not "Error 422" but "We couldn't save your changes").
2. **Explain why it matters** in terms of the user's goal (not "Request timeout" but "Your message wasn't sent").
3. **Tell them what to do** with a specific, actionable next step (not "Contact support" alone but "Try again, or contact support at help@example.com if this continues").

Tone matters. Error messages should be calm, helpful, and blame-free. Never say "You entered an invalid..." — say "Please enter a valid..." The user is not at fault; the system is asking for help.

### Onboarding Should Serve the User's Goal, Not the Product's Tour

The worst onboarding experiences are product-centric: "Let me show you all 47 features." The best are user-centric: "What are you trying to accomplish? Let me help you do that."

Every onboarding step should be evaluated by one criterion: does this help the user reach their first moment of value faster? If a step is about the product's capabilities rather than the user's goal, cut it. The user will discover secondary features organically once they are invested in the product through achieving their primary goal.

The first moment of value — the "aha moment" — is different for every product. For a project management tool, it might be creating a task and seeing it on a board. For a communication tool, it might be sending a first message. For an analytics tool, it might be seeing a chart of their own data. Onboarding should be a direct path to that moment, with no detours.

---

## Empty State Content Strategy

Empty states are writing challenges as much as design challenges. The copy in an empty state sets the tone for the user's entire relationship with a feature.

### Voice and Tone Guidelines

- **Be warm, not robotic.** "No notifications yet" is cold. "You're all caught up — we'll let you know when something needs your attention" is warm and informative.
- **Be specific, not generic.** "No data available" is useless. "No sales data for March. Data will appear here once your first invoice is recorded" is actionable.
- **Be encouraging in first-use states.** The user just signed up — they are motivated. Channel that energy: "Your dashboard will come alive as you add projects. Let's create your first one."
- **Be concise.** Empty state copy should not exceed 2-3 sentences. The user needs direction, not a paragraph.
- **Avoid blame.** Never say "You haven't added anything yet." Instead, "This space is ready for your first [item]." The distinction is subtle but important — the first frames the empty state as the user's failure, the second frames it as potential.

### Illustration Guidelines

Empty state illustrations should:

- **Be relevant to the content type.** An empty inbox illustration should depict a mailbox or envelope, not an abstract shape. The illustration helps the user understand what will eventually appear in this space.
- **Use the product's design language.** Match the color palette, illustration style, and overall aesthetic of the application. A quirky hand-drawn illustration in an otherwise corporate enterprise app creates tonal dissonance.
- **Stay lightweight.** Empty state illustrations should be SVG or small raster files. They appear on pages that may already have performance concerns (the content failed to load or has not been created yet) — a heavy illustration compounds the problem.
- **Support dark mode.** If the application has a dark mode, ensure empty state illustrations adapt. This often means creating separate light and dark variants, or using illustrations that work on both backgrounds.
- **Be optional on mobile.** On small screens, space is precious. Consider hiding or reducing the illustration on mobile viewports and leading with the text and CTA.

---

## Error Recovery Patterns

Beyond displaying error messages, the interface must actively help users recover from errors. Error recovery is the path from "something went wrong" back to "I can continue working."

### Automatic Retry with Backoff

For transient errors (network timeouts, server 503s), implement automatic retry before showing an error to the user:

```javascript
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status >= 500) {
        lastError = new Error(`Server error: ${response.status}`);
      } else {
        // Client errors (4xx) should not be retried
        throw new Error(`Request failed: ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }

    // Exponential backoff: 1s, 2s, 4s
    const delay = Math.pow(2, attempt) * 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw lastError;
}
```

The user should only see an error message if all retry attempts fail. For fast-failing errors (400 Bad Request, 403 Forbidden), do not retry — show the error immediately.

### Graceful Degradation

When a non-critical feature fails, the rest of the application should continue functioning:

- If the recommendation engine fails, show the content without recommendations rather than an error page.
- If analytics tracking fails, do not block the user's workflow.
- If a secondary API call fails, show the primary content and display an inline error for the failed section: "Unable to load comments. Retry"

This approach requires designing components that can render independently, with explicit loading and error states for each data dependency.

### Undo as Error Prevention

For destructive actions, an undo mechanism prevents errors from needing recovery at all:

- **Soft delete:** When a user deletes an item, mark it as deleted in the database but do not purge it. Show a toast: "Item deleted. Undo" with a 10-second window to reverse the action.
- **Outbox pattern for messages:** After the user clicks "Send", show a brief (3-5 second) "Sending..." state with an "Undo" option before actually dispatching the message.
- **Trash/archive instead of permanent delete:** Move items to a recoverable location rather than destroying them immediately.

---

## Onboarding Metrics and Optimization

Onboarding is not a "design it once and ship it" feature. It requires continuous measurement and iteration.

### Key Metrics

- **Activation rate:** Percentage of new users who complete the core onboarding flow and reach the first moment of value (the "aha moment"). This is the single most important onboarding metric.
- **Time to value:** Duration between account creation and the user's first meaningful action (creating a project, sending a message, generating a report). Shorter is better.
- **Checklist completion rate:** What percentage of users complete each checklist step? Steps with low completion rates are either poorly designed, poorly explained, or unnecessary.
- **Tour skip rate:** What percentage of users skip the guided tour? A high skip rate (above 50%) suggests the tour is not perceived as valuable. Consider making it shorter or replacing it with progressive disclosure.
- **Day-1 retention:** Do users who complete onboarding return the next day at higher rates than those who skip it? If not, the onboarding is not delivering value.
- **Feature adoption over time:** Track which features users discover and adopt over the first 30 days. Compare users who went through different onboarding variants.

### Onboarding A/B Testing

Onboarding is an excellent candidate for A/B testing because the audience (new users) is naturally segmented and the outcomes (activation, retention) are clearly measurable.

Test these variables:

- **Number of steps:** Does a 3-step flow outperform a 5-step flow?
- **Interactivity:** Does an interactive walkthrough (where the user clicks real buttons) outperform a passive tour (where the user clicks "Next")?
- **Checklist vs. tour:** Does a persistent checklist drive higher activation than a one-time guided tour?
- **Sample data vs. empty state:** Does pre-populated sample data lead to faster understanding than a first-use empty state with a CTA?
- **Video vs. no video:** Does including a short walkthrough video improve activation or just delay it?

### The Onboarding Funnel

Model onboarding as a funnel with measurable stages:

```
Sign up
  |-- Account created (100%)
  v
First screen
  |-- Viewed onboarding prompt (95%)
  v
Core action
  |-- Started core action (70%)
  v
First value
  |-- Completed first meaningful task (50%)
  v
Aha moment
  |-- Experienced core value proposition (35%)
  v
Retained
  |-- Returned within 7 days (25%)
```

Identify the largest drop-off points in this funnel. Those are the highest-leverage opportunities for improvement. If users view the onboarding prompt but do not start the core action, the prompt is failing to motivate. If users start the core action but do not complete it, the action is too complex or poorly guided.

---

## Accessibility Considerations for States

Every state pattern must be accessible. States that only communicate through visual means exclude users who rely on assistive technology.

### Loading States

- Use `role="status"` or `aria-live="polite"` on loading containers so screen readers announce when loading begins.
- Provide a text alternative: "Loading your messages" inside a visually hidden `<span>`. Skeleton screens are visually informative but meaningless to screen readers.
- When loading completes, announce the result: "12 messages loaded" via an `aria-live` region, or move focus to the first item.

### Error States

- Use `role="alert"` for error messages that require immediate attention. This triggers an assertive announcement in screen readers.
- Associate inline errors with their fields via `aria-describedby` and mark the field with `aria-invalid="true"`.
- Manage focus: when a form submission fails, move focus to the error summary or the first field with an error.

### Empty States

- Ensure empty state illustrations have `alt=""` (empty alt) or `aria-hidden="true"` if they are decorative. If the illustration conveys meaning, provide descriptive alt text.
- The CTA button in the empty state should be a real `<button>` or `<a>` element, not a styled `<div>`. It must be keyboard-focusable and have a descriptive label.

### Onboarding Overlays

- Coach mark overlays must trap focus within the tooltip so keyboard users can interact with the "Next" and "Skip" buttons without tabbing into the dimmed background.
- Announce each step change: "Step 2 of 4: Click the Create button to make a new project."
- The "Skip tour" button must be reachable by keyboard on every step.
- When the tour ends, return focus to a logical location — typically the element that was highlighted in the final step, or the main content area.

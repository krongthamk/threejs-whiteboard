import { Component, type ReactNode } from 'react';

/** Keep the account shell available when a board component cannot render. */
export class BoardErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="workspace">
      <div className="error-banner" role="alert">
        <span>This board could not be displayed. Reload the board to try again.</span>
        <button className="board-reload" onClick={() => window.location.reload()}>Reload board</button>
      </div>
    </main>;
  }
}

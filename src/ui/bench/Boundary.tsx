/** Keeps one broken part (a window, the canvas) from taking the whole workbench down. */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props { what: string; children: ReactNode }
interface State { error: Error | null }

export class Boundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error(`[workbench] ${this.props.what} failed`, error, info.componentStack); }
  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="wb-crash note bad" role="alert">
        <strong>{this.props.what} hit a problem.</strong>
        <p>Your lab is not lost. Press the button to show this part again.</p>
        <p className="muted wb-crash-detail">{this.state.error.message}</p>
        <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

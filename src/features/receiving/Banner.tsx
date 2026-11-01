import type { Message } from "../../api/problemMessages";

export function Banner({ message }: { message: Message }) {
  return (
    <div className={`floor-notice floor-notice--${message.tone}`} role="alert">
      <p className="floor-notice__what">{message.what}</p>
      <p className="floor-notice__todo">{message.todo}</p>
    </div>
  );
}

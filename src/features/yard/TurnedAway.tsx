import { Card } from "@warehouse/ui-kit";
import { turnAwayTitle, type TurnAway } from "./turnAway";
import { YardNotice } from "./yardUi";

/**
 * A check-in the service answered with a recorded turn-away.
 *
 * Blocking (the truck in the form was the one turned away): the card takes the
 * place of the check-in form, nothing typed for that truck is left to send, the
 * message has no Dismiss and the only way on is the one button.
 *
 * Not blocking (an earlier, saved truck was turned away while the clerk had
 * moved on): the card only announces it, above a form that is left alone, and
 * is dismissed like any notice.
 */
export function TurnedAway({ turnAway, onNext }: { turnAway: TurnAway; onNext: () => void }) {
  return (
    <Card title={turnAwayTitle(turnAway.tractorPlates)}>
      <div className="floor-form">
        {turnAway.blocking ? <YardNotice message={turnAway.message} /> : <YardNotice message={turnAway.message} onDismiss={onNext} />}
        {turnAway.blocking && (
          <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" onClick={onNext}>
            Start the next truck
          </button>
        )}
      </div>
    </Card>
  );
}

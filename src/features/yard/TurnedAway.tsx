import { Card } from "@warehouse/ui-kit";
import { turnAwayTitle, type TurnAway } from "./turnAway";
import { YardNotice } from "./yardUi";

/**
 * The end of a check-in the service answered with a recorded turn-away. It
 * takes the place of the check-in form: nothing the clerk typed for this truck
 * is left to send, so a stray tap cannot put a second turn-away on record. The
 * message has no Dismiss; the only way on is the one button.
 */
export function TurnedAway({ turnAway, onNext }: { turnAway: TurnAway; onNext: () => void }) {
  return (
    <Card title={turnAwayTitle(turnAway.tractorPlates)}>
      <div className="floor-form">
        <YardNotice message={turnAway.message} />
        <button type="button" className="floor-btn floor-btn--primary floor-btn--xl" onClick={onNext}>
          Start the next truck
        </button>
      </div>
    </Card>
  );
}

import { Link } from "react-router-dom";
import { Card } from "@warehouse/ui-kit";

export function NotFoundScreen() {
  return (
    <Card title="Page not found">
      <p>There is nothing at this address.</p>
      <Link className="floor-btn floor-btn--primary" to="/">
        Back to the station
      </Link>
    </Card>
  );
}

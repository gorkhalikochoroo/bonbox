// BookingTile — one choice on the public booking page (party size, time).
// A plain <button> with the booking-local tile classes (bookingTiles.js);
// never the shared ui/Chip, whose outlined look the owner app keeps.
// The children sit in a <span>, as they did inside ui/Chip, so the DOM a
// guest's screen reader walks is unchanged.
import { forwardRef } from "react";
import { tileClass } from "./bookingTiles";

const BookingTile = forwardRef(function BookingTile(
  { selected = false, className = "", children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium whitespace-nowrap select-none " +
        "focus-visible:outline-none " +
        tileClass({ picked: selected }) +
        (className ? " " + className : "")
      }
      {...rest}
    >
      <span>{children}</span>
    </button>
  );
});

export default BookingTile;

/** Blocking error state: a failure that left the viewer with nothing to show */

import { colors, styles } from "~/shared/theme";

export function DoclistErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        margin: 16,
        ...styles.card,
        borderColor: colors.error,
        color: colors.error,
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}

/** The reason filled in for an approval, for one application or several. */
export const approveReason = "Website whitelist application reviewed and approved.";

/** Why a review reason cannot be sent, or "" when it can. The server applies the same rule. */
export function reasonProblem(reason: string) {
  return reason.length < 3 ||
    reason.length > 200 ||
    [...reason].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? "Enter a single-line review reason between 3 and 200 characters."
    : "";
}

const QUIET = "<!-- styal-report:quiet -->";
const OK = "<!-- styal-report:ok -->";
const ATTENTION = "<!-- styal-report:attention -->";

function prepareReport(body, existingBody) {
  if (!body.split("\n").includes(OK)) return body;
  // Recovery is loud once; subsequent healthy edits may be quiet again.
  if (existingBody !== undefined && !existingBody.split("\n").includes(OK)) return body;
  return body + "\n" + QUIET;
}

module.exports = { prepareReport, OK, ATTENTION, QUIET };

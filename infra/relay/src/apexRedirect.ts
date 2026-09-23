/** The managed tunnel zone's apex points visitors to the project. */
export default {
  fetch: (request: Request) =>
    Response.redirect(`https://github.com/incognitojam/styal${new URL(request.url).search}`, 302),
};

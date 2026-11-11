import { createFileRoute, redirect } from "@tanstack/react-router";

/** A skill written for every Bot has its page under Skills now, in the main menu. */
export const Route = createFileRoute(
  "/_authed/settings/_personal/skills_/$slug",
)({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/skills/$slug",
      params: { slug: params.slug },
      replace: true,
    });
  },
});

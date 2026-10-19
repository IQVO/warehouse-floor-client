import { Link as RouterDomLink } from "react-router-dom";
import type { LinkProps, LinkComponent } from "@warehouse/ui-kit";
import type { ReactElement } from "react";

/**
 * Adapts react-router's Link to the ui-kit's router-agnostic LinkProps.
 * Module scope on purpose (a component defined inline would remount every link
 * on each render). External and protocol-relative links stay plain anchors.
 */
export const RouterLink: LinkComponent = ({ href, children, ...rest }: LinkProps): ReactElement => {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <RouterDomLink to={href} {...rest}>
      {children}
    </RouterDomLink>
  );
};

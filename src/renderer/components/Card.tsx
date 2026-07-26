import { type HTMLAttributes, forwardRef } from "react";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className = "", children, ...rest }, ref) => {
    return (
      <div ref={ref} className={`card ${className}`.trim()} {...rest}>
        {children}
      </div>
    );
  }
);
Card.displayName = "Card";

import { type ButtonHTMLAttributes, forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "default" | "sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "default", className = "", children, ...rest }, ref) => {
    const variantClass = variant === "primary" ? "btn-primary"
      : variant === "ghost" ? "btn-ghost"
      : variant === "danger" ? "btn-danger"
      : "btn-secondary";
    const sizeClass = size === "sm" ? "btn-sm" : "";
    return (
      <button
        ref={ref}
        className={`btn ${variantClass} ${sizeClass} ${className}`.trim()}
        {...rest}
      >
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

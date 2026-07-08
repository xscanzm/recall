import { type HTMLAttributes } from "react";

export type TagType = "project" | "category" | "warning" | "private" | "reportable";

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  type?: TagType;
}

export const Tag = ({ type = "category", className = "", children, ...rest }: TagProps) => {
  const typeClass = `tag-${type}`;
  return (
    <span className={`tag ${typeClass} ${className}`.trim()} {...rest}>
      {children}
    </span>
  );
};

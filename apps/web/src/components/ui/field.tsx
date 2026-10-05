import * as React from "react";

import { cn } from "~/lib/utils";
import { Label } from "~/components/ui/label";

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="field-group" className={cn("@container/field-group flex flex-col gap-4", className)} {...props} />
  );
}

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & { orientation?: "vertical" | "horizontal" | "responsive" }) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      role="group"
      className={cn(
        "flex min-w-0 flex-col gap-2 data-[invalid]:text-destructive",
        orientation === "horizontal" && "flex-row items-center",
        orientation === "responsive" && "@md/field-group:flex-row @md/field-group:items-center",
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={cn("font-medium", className)} {...props} />;
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-error" className={cn("text-sm text-destructive", className)} {...props} />;
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel };

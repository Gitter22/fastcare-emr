import * as React from "react";
import {
  Controller,
  useForm,
  type FieldPath,
  type FieldValues,
  type Path,
  type UseFormProps,
  type UseFormReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { DateInput } from "./date";
import { Input, Label, Textarea } from "./input";
import { Checkbox, RadioGroup, Select, type Option } from "./select";

/** react-hook-form + zod (Pine: shadcn Form). */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  props: Omit<UseFormProps<z.input<S>, unknown, z.output<S>>, "resolver"> = {},
) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never) as never,
    mode: "onTouched",
    ...props,
  });
}

/**
 * Puts server validation errors (Problem.errors[].field like "body.patient.firstName") on the matching fields.
 * Returns the messages that matched no field so the caller can show them in an alert.
 */
export function applyServerErrors<T extends FieldValues>(
  form: UseFormReturn<T, unknown, never> | UseFormReturn<T>,
  e: unknown,
  map: Record<string, string> = {},
): string[] {
  if (!(e instanceof ApiError) || !e.problem.errors?.length) return [];
  const rest: string[] = [];
  for (const err of e.problem.errors) {
    const path = err.field.replace(/^body\.?/, "");
    const target = map[path] ?? path;
    if (
      target &&
      (form.getValues() as Record<string, unknown>) &&
      hasPath(form.getValues(), target)
    ) {
      form.setError(target as Path<T>, { type: "server", message: err.message });
    } else rest.push(err.message);
  }
  return rest;
}

function hasPath(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur && typeof cur === "object" && k in (cur as object))
      cur = (cur as Record<string, unknown>)[k];
    else return false;
  }
  return true;
}

export function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid content-start gap-1.5 min-w-0", className)}>
      {label ? (
        <Label htmlFor={htmlFor}>
          {label}
          {required ? <span aria-hidden> *</span> : null}
        </Label>
      ) : null}
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-small text-danger-ink" role="alert">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />
          {error}
        </p>
      ) : hint ? (
        <p className="text-small text-ink-2">{hint}</p>
      ) : null}
    </div>
  );
}

interface BaseProps<T extends FieldValues> {
  form: UseFormReturn<T, unknown, never> | UseFormReturn<T>;
  name: FieldPath<T>;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
  testId?: string;
  disabled?: boolean;
}

function useFieldError<T extends FieldValues>(
  form: BaseProps<T>["form"],
  name: FieldPath<T>,
): string | undefined {
  const err = name
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      form.formState.errors,
    );
  return (err as { message?: string } | undefined)?.message;
}

export function TextField<T extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  className,
  testId,
  disabled,
  type = "text",
  placeholder,
  autoComplete,
  multiline,
  inputMode,
}: BaseProps<T> & {
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  multiline?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  const id = React.useId();
  const error = useFieldError(form, name);
  const reg = (form as UseFormReturn<T>).register(name);
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {multiline ? (
        <Textarea
          id={id}
          data-testid={testId}
          aria-invalid={!!error || undefined}
          disabled={disabled}
          placeholder={placeholder}
          {...reg}
        />
      ) : (
        <Input
          id={id}
          data-testid={testId}
          type={type}
          aria-invalid={!!error || undefined}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          {...reg}
        />
      )}
    </FieldShell>
  );
}

export function SelectField<T extends FieldValues, V extends string>({
  form,
  name,
  label,
  hint,
  required,
  className,
  testId,
  disabled,
  options,
  placeholder,
}: BaseProps<T> & { options: Option<V>[]; placeholder?: string }) {
  const id = React.useId();
  const error = useFieldError(form, name);
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <Controller
        control={(form as UseFormReturn<T>).control}
        name={name}
        render={({ field }) => (
          <Select
            id={id}
            testId={testId}
            value={(field.value as V | undefined) ?? ""}
            onValueChange={(v) => field.onChange(v)}
            options={options}
            placeholder={placeholder}
            invalid={!!error}
            disabled={disabled}
          />
        )}
      />
    </FieldShell>
  );
}

export function DateField<T extends FieldValues>({
  form,
  name,
  label,
  hint,
  required,
  className,
  testId,
  disabled,
}: BaseProps<T>) {
  const id = React.useId();
  const error = useFieldError(form, name);
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <Controller
        control={(form as UseFormReturn<T>).control}
        name={name}
        render={({ field }) => (
          <DateInput
            id={id}
            testId={testId}
            value={field.value as string | undefined}
            onChange={(v) => field.onChange(v ?? "")}
            onBlur={field.onBlur}
            invalid={!!error}
            disabled={disabled}
          />
        )}
      />
    </FieldShell>
  );
}

export function CheckboxField<T extends FieldValues>({
  form,
  name,
  label,
  className,
  testId,
  disabled,
}: BaseProps<T>) {
  const error = useFieldError(form, name);
  return (
    <div className={cn("grid gap-1", className)}>
      <Controller
        control={(form as UseFormReturn<T>).control}
        name={name}
        render={({ field }) => (
          <Checkbox
            data-testid={testId}
            checked={!!field.value}
            onCheckedChange={(c) => field.onChange(c === true)}
            label={label}
            disabled={disabled}
            aria-invalid={!!error || undefined}
          />
        )}
      />
      {error ? <p className="text-small text-danger-ink">{error}</p> : null}
    </div>
  );
}

export function RadioField<T extends FieldValues, V extends string>({
  form,
  name,
  label,
  hint,
  className,
  testId,
  options,
}: BaseProps<T> & { options: Option<V>[] }) {
  const error = useFieldError(form, name);
  return (
    <FieldShell label={label} hint={hint} error={error} className={className}>
      <Controller
        control={(form as UseFormReturn<T>).control}
        name={name}
        render={({ field }) => (
          <RadioGroup
            testId={testId}
            value={field.value as V}
            onValueChange={field.onChange}
            options={options}
          />
        )}
      />
    </FieldShell>
  );
}

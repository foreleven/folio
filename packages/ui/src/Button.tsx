import type { ButtonHTMLAttributes } from 'react'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

/**
 * Renders the shared primary action. Native button attributes are forwarded so
 * consumers keep standard accessibility and event behavior.
 */
export function Button({ className, type = 'button', ...props }: ButtonProps): React.JSX.Element {
  const classes = ['ui-button', className].filter(Boolean).join(' ')

  return <button className={classes} type={type} {...props} />
}


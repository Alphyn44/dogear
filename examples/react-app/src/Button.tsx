/**
 * Where the element literally lives, in the brief's running example.
 *
 * This file exists to be the `Button.tsx:12` half of the source-resolution problem: alt-click
 * a tab and the `<button>` you pointed at was written *here*, while the decision to put it in
 * a row was made in TabBar.tsx. dogear does not choose between them — C2 (#16) sends both and
 * lets the comment disambiguate.
 *
 * Deliberately one element deep. A wrapper `<span>` would be more realistic and would blur
 * the thing this file is here to demonstrate.
 */

interface ButtonProps {
  readonly label: string
  readonly onClick: () => void
}

export function Button({ label, onClick }: ButtonProps) {
  return (
    <button className="tab" type="button" onClick={onClick}>
      {label}
    </button>
  )
}

import { IconSearch, IconX } from "@tabler/icons-react";
import { useRef } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";

export function PanelSearch({
  label,
  placeholder,
  value,
  onChange,
  describedBy,
  mobile,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
  mobile: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <InputGroup
      className={
        mobile ? "mobile-panel-search" : "h-9 rounded-lg bg-background text-sm"
      }
    >
      <InputGroupInput
        aria-label={label}
        aria-describedby={describedBy}
        ref={input}
        enterKeyHint={mobile ? "search" : undefined}
        onKeyDown={(event) => {
          if (mobile && event.key === "Enter" && !event.nativeEvent.isComposing)
            input.current?.blur();
        }}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
      <InputGroupAddon>
        <IconSearch aria-hidden="true" />
      </InputGroupAddon>
      {mobile && value && (
        <button
          type="button"
          className="mobile-search-clear"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <IconX size={17} aria-hidden="true" />
        </button>
      )}
    </InputGroup>
  );
}

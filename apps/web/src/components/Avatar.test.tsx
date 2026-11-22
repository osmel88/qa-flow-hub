import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BRANDING } from '../branding';
import { Avatar, initialsOf } from './Avatar';
import { Brand } from './Brand';

describe('initialsOf', () => {
  it.each([
    ['Ana García López', null, 'AL'],
    ['ana', null, 'A'],
    ['  ', 'zoe@example.com', 'Z'],
    [null, null, '?'],
  ])('%j / %j → %s', (name, email, expected) => {
    expect(initialsOf(name, email)).toBe(expected);
  });
});

describe('Avatar', () => {
  it('shows the picture when there is an avatarUrl', () => {
    const { container } = render(<Avatar name="Ana García" avatarUrl="/brand/logo.svg" />);
    expect(container.querySelector('img')).toHaveAttribute('src', '/brand/logo.svg');
    expect(screen.getByTestId('avatar')).not.toHaveTextContent('AG');
  });

  it('falls back to the initials without a URL or when the image fails to load', () => {
    const { container, rerender } = render(<Avatar name="Ana García" avatarUrl={null} />);
    expect(screen.getByTestId('avatar')).toHaveTextContent('AG');

    rerender(<Avatar name="Ana García" avatarUrl="https://blocked.example/a.png" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('avatar')).toHaveTextContent('AG');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Brand', () => {
  it('renders the configured name and logo from one place', () => {
    const { container } = render(<Brand />);
    expect(screen.getByTestId('brand')).toHaveTextContent(BRANDING.name);
    expect(container.querySelector('img')).toHaveAttribute('src', BRANDING.logoUrl);
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });
});

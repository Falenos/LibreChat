# agentic-karl

agentic-karl

## Prerequisites

- [Node.js](https://nodejs.org/) v24+ (use `nvm use` to switch)
- [npm](https://www.npmjs.com/) (bundled with Node.js)

## Getting Started

```bash
# Install dependencies
npm install

# Start development server at http://localhost:3000
npm run dev
```

## Scripts

| Command                 | Description                      |
| ----------------------- | -------------------------------- |
| `npm run dev`           | Start development server         |
| `npm run build`         | Create production build          |
| `npm start`             | Start production server          |
| `npm run lint`          | Run ESLint                       |
| `npm run lint:fix`      | Run ESLint with auto-fix         |
| `npm run format`        | Format code with Prettier        |
| `npm run format:check`  | Check formatting without writing |
| `npm test`              | Run tests                        |
| `npm run test:watch`    | Run tests in watch mode          |
| `npm run test:coverage` | Run tests with coverage report   |

## Tech Stack

- [Next.js 16](https://nextjs.org/) — App Router with standalone output
- [React 19](https://react.dev/) — with React Compiler
- [TypeScript 5](https://www.typescriptlang.org/)
- [Tailwind CSS 4](https://tailwindcss.com/) — via PostCSS
- [Jest 30](https://jestjs.io/) + [Testing Library](https://testing-library.com/) — unit testing
- [ESLint 9](https://eslint.org/) — flat config with `@next/eslint-plugin-next` and `typescript-eslint`
- [Prettier 3](https://prettier.io/) — code formatting
- [Husky 9](https://typicode.github.io/husky/) + [lint-staged 16](https://github.com/lint-staged/lint-staged) — pre-commit hooks

## Docker

```bash
# Using Docker Compose
docker compose up

# Or build and run manually
docker build -t agentic-karl --build-arg NPM_TOKEN=<token> .
docker run -p 3000:3000 agentic-karl
```

## Project Structure

```
src/
├── app/                 # Next.js App Router pages and layouts
│   ├── globals.css      # Global styles and Tailwind imports
│   ├── layout.tsx       # Root layout
│   └── page.tsx         # Home page
└── __mocks__/           # Jest mocks for static assets
```

## Team

- **Owner:** [@Knauf-Group/ct-kdp-ateam-group](https://github.com/orgs/Knauf-Group/teams/ct-kdp-ateam-group)

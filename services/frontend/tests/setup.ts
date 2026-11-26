/**
 * Vitest Test Setup
 * Configures global test utilities including testing-library matchers
 */

import '@testing-library/jest-dom';
import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

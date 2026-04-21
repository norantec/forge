import { ESLintUtil } from '@open-norantec/utilities/dist/eslint-util.class.js';

export default ESLintUtil.create({
  project: './tsconfig.eslint.json',
  ignores: ['dist*'],
});

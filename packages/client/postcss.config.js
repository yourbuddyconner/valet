export default {
  plugins: {
    tailwindcss: {},
    // Rewrites pixel values to rems on typography properties only, so the
    // user-controlled font-size on <html> scales all type across the app while
    // leaving borders, paddings, gaps, and shadows pixel-perfect.
    'postcss-pxtorem': {
      rootValue: 16,
      unitPrecision: 5,
      propList: ['font-size', 'line-height', 'letter-spacing'],
      minPixelValue: 2,
      exclude: /node_modules/,
    },
    autoprefixer: {},
  },
};
